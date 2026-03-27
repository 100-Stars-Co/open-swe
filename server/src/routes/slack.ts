/**
 * Slack webhook route handler.
 * Ports the Slack webhook logic from agent/webapp.py to Hono + TypeScript.
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { config, isRepoOrgAllowed } from "../utils/config.ts";
import { verifySlackSignature, addSlackReaction, fetchSlackThreadMessages, getSlackUserInfo, getSlackUserNames, selectSlackContextMessages, formatSlackMessagesForPrompt, postSlackTraceReply, postSlackThreadReply, stripBotMention } from "../utils/slack.ts";
import { extractRepoFromText } from "../utils/repo.ts";
import { extractImageUrls, dedupeUrls, fetchImageBlock } from "../utils/multimodal.ts";
import { getLangGraphClient, isThreadActive, queueMessageForThread, upsertThreadRepoMetadata, extractRepoConfigFromThread } from "../utils/langgraph.ts";

const app = new Hono();

/** Generate a deterministic LangGraph thread ID from a Slack channel + thread_ts. */
function generateThreadIdFromSlackThread(channelId: string, threadId: string): string {
  // Use MD5 to match the Python implementation (uuid.UUID(hex=md5_hex))
  const composite = `${channelId}:${threadId}`;
  const md5Hex = createHash("md5").update(composite, "utf-8").digest("hex");
  // Format as UUID
  return [
    md5Hex.slice(0, 8),
    md5Hex.slice(8, 12),
    md5Hex.slice(12, 16),
    md5Hex.slice(16, 20),
    md5Hex.slice(20, 32),
  ].join("-");
}

async function checkIfUsingRepoMsgSent(
  channelId: string,
  threadTs: string,
  usingRepoStr: string,
): Promise<boolean> {
  const messages = await fetchSlackThreadMessages(channelId, threadTs);
  return messages.some((m) => (m.text ?? "").includes(usingRepoStr));
}

async function getSlackRepoConfig(
  message: string,
  channelId: string,
  threadTs: string,
): Promise<{ owner: string; name: string }> {
  const defaultOwner = config.slackRepoOwner || config.defaultRepoOwner;
  const defaultName = config.slackRepoName || config.defaultRepoName;
  const threadId = generateThreadIdFromSlackThread(channelId, threadTs);
  const client = getLangGraphClient();

  let repoConfig = extractRepoFromText(message, defaultOwner);

  if (!repoConfig) {
    try {
      const thread = await client.threads.get(threadId);
      const fromThread = extractRepoConfigFromThread(thread as unknown as Record<string, unknown>);
      if (fromThread) repoConfig = fromThread;
    } catch {
      // Thread doesn't exist yet — that's fine
    }
  }

  if (!repoConfig) {
    repoConfig = { owner: defaultOwner, name: defaultName };
  }

  const usingRepoStr = `Using repository: \`${repoConfig.owner}/${repoConfig.name}\``;
  const alreadySent = await checkIfUsingRepoMsgSent(channelId, threadTs, usingRepoStr);
  if (!alreadySent) {
    await postSlackThreadReply(channelId, threadTs, usingRepoStr);
  }

  return repoConfig;
}

async function processSlackMention(
  eventData: {
    channel_id: string;
    thread_ts: string;
    event_ts: string;
    user_id: string;
    text: string;
    bot_user_id: string;
  },
  repoConfig: { owner: string; name: string },
): Promise<void> {
  const { channel_id: channelId, thread_ts: threadTs, event_ts: eventTs, user_id: userId, text, bot_user_id: botUserId } = eventData;

  if (!channelId || !threadTs || !eventTs) return;

  await addSlackReaction(channelId, eventTs, "eyes");

  const threadId = generateThreadIdFromSlackThread(channelId, threadTs);

  let userEmail: string | undefined;
  let userName = "";

  if (userId) {
    const slackUser = await getSlackUserInfo(userId);
    if (slackUser) {
      const profile = slackUser["profile"] as Record<string, string> | undefined;
      if (profile) {
        userEmail = profile["email"];
        userName =
          profile["display_name"] || profile["real_name"] ||
          (slackUser["real_name"] as string | undefined) ||
          (slackUser["name"] as string | undefined) || "";
      }
    }
  }

  let threadMessages = await fetchSlackThreadMessages(channelId, threadTs);
  if (!threadMessages.some((m) => String(m.ts) === String(eventTs))) {
    threadMessages.push({ ts: eventTs, text, user: userId });
  }

  const [contextMessages, contextMode] = selectSlackContextMessages(
    threadMessages,
    eventTs,
    botUserId,
    config.slackBotUsername,
  );

  const contextUserIds = contextMessages
    .map((m) => m.user)
    .filter((u): u is string => typeof u === "string" && Boolean(u));

  const userNamesById = await getSlackUserNames(contextUserIds);
  if (userId && userName && !(userId in userNamesById)) {
    userNamesById[userId] = userName;
  }

  const contextText = formatSlackMessagesForPrompt(
    contextMessages,
    userNamesById,
    botUserId,
    config.slackBotUsername,
  );

  const contextSource =
    contextMode === "last_mention"
      ? "the previous message where I was tagged"
      : "the beginning of the thread";

  const cleanText = stripBotMention(text, botUserId, config.slackBotUsername) || "(no text in mention)";
  const triggerUser = userName || (userId ? `<@${userId}>` : "Unknown user");

  const prompt =
    "You were mentioned in Slack.\n\n" +
    `## Repository\n${repoConfig.owner}/${repoConfig.name}\n\n` +
    `## Triggered by\n${triggerUser}\n\n` +
    `## Slack Thread\n- Channel: ${channelId}\n- Thread TS: ${threadTs}\n` +
    `- Context starts at: ${contextSource}\n\n` +
    `## Conversation Context\n${contextText}\n\n` +
    `## Latest Mention Request\n${cleanText}\n\n` +
    "Use `slack_thread_reply` to communicate in this Slack thread for clarifications, " +
    "status updates, and final summaries.";

  const contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  const imageUrls = dedupeUrls([
    ...contextMessages.flatMap((msg) => extractImageUrls(msg.text ?? "")),
    ...contextMessages.flatMap((msg) =>
      (msg.files ?? [])
        .filter((f) => f.mimetype?.startsWith("image/") && f.url_private)
        .map((f) => f.url_private as string),
    ),
  ]);

  for (const imageUrl of imageUrls) {
    const block = await fetchImageBlock(imageUrl);
    if (block) contentBlocks.push(block as unknown as Record<string, unknown>);
  }

  const configurableData = {
    repo: repoConfig,
    slack_thread: {
      channel_id: channelId,
      thread_ts: threadTs,
      triggering_user_id: userId,
      triggering_user_name: userName,
      triggering_user_email: userEmail ?? "",
      triggering_event_ts: eventTs,
    },
    user_email: userEmail ?? "",
    source: "slack",
  };

  const client = getLangGraphClient();
  await upsertThreadRepoMetadata(threadId, repoConfig);

  const threadActive = await isThreadActive(threadId);
  if (threadActive) {
    await queueMessageForThread(threadId, { text: prompt, image_urls: [] });
    return;
  }

  const run = await client.runs.create(
    threadId,
    "agent",
    {
      input: { messages: [{ role: "user", content: contentBlocks }] },
      metadata: config.agentVersionMetadata,
      config: { configurable: configurableData },
      ifNotExists: "create",
      multitaskStrategy: "interrupt",
    },
  );
  const runId = (run as { run_id?: string }).run_id ?? "";
  await postSlackTraceReply(channelId, threadTs, runId);
}

// POST /webhooks/slack
app.post("/", async (c) => {
  const bodyBytes = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("X-Slack-Signature") ?? "";
  const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";

  if (!verifySlackSignature(bodyBytes, timestamp, signature, config.slackSigningSecret)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyBytes.toString("utf-8"));
  } catch {
    return c.json({ status: "error", message: "Invalid JSON" });
  }

  // URL verification challenge
  if (payload["type"] === "url_verification") {
    return c.json({ challenge: payload["challenge"] });
  }

  if (payload["type"] !== "event_callback") {
    return c.json({ status: "ignored", reason: "Not an event callback" });
  }

  const event = (payload["event"] as Record<string, unknown> | undefined) ?? {};
  const messageText = (event["text"] as string | undefined) ?? "";

  // Accept app_mention or message events that mention the bot by username or user ID
  if (event["type"] !== "app_mention") {
    const hasByUsername = Boolean(
      event["type"] === "message" && config.slackBotUsername && messageText.includes(`@${config.slackBotUsername}`),
    );
    const hasByUserId = Boolean(
      event["type"] === "message" && config.slackBotUserId && messageText.includes(`<@${config.slackBotUserId}>`),
    );
    if (!hasByUsername && !hasByUserId) {
      return c.json({ status: "ignored", reason: "Not an app_mention event" });
    }
  }

  if (event["subtype"] === "bot_message" || event["bot_id"]) {
    return c.json({ status: "ignored", reason: "Event from a bot" });
  }

  const channelId = (event["channel"] as string | undefined) ?? "";
  const eventTs = (event["ts"] as string | undefined) ?? "";
  const threadTs = (event["thread_ts"] as string | undefined) ?? eventTs;
  const userId = (event["user"] as string | undefined) ?? "";

  if (!channelId || !eventTs || !threadTs) {
    return c.json({ status: "ignored", reason: "Missing channel/thread timestamp" });
  }

  // Resolve bot user ID
  let botUserId = config.slackBotUserId;
  if (!botUserId) {
    const authorizations = payload["authorizations"];
    if (Array.isArray(authorizations) && authorizations.length > 0) {
      const authUserId = (authorizations[0] as Record<string, unknown>)?.["user_id"];
      if (typeof authUserId === "string") botUserId = authUserId;
    }
  }
  if (!botUserId) {
    const authedUsers = payload["authed_users"];
    if (Array.isArray(authedUsers) && authedUsers.length > 0) {
      if (typeof authedUsers[0] === "string") botUserId = authedUsers[0];
    }
  }

  if (botUserId && userId === botUserId) {
    return c.json({ status: "ignored", reason: "Event from this bot user" });
  }

  const eventData = { channel_id: channelId, thread_ts: threadTs, event_ts: eventTs, user_id: userId, text: messageText, bot_user_id: botUserId };
  const repoConfig = await getSlackRepoConfig(messageText, channelId, threadTs);

  if (!isRepoOrgAllowed(repoConfig)) {
    return c.json({ status: "ignored", reason: "Repository org not in allowlist" });
  }

  // Fire and forget
  processSlackMention(eventData, repoConfig).catch((err) =>
    console.error("Failed to process Slack mention:", err),
  );

  return c.json({ status: "accepted", message: "Slack mention queued" });
});

// GET /webhooks/slack — verification endpoint
app.get("/", (c) => c.json({ status: "ok", message: "Slack webhook endpoint is active" }));

export { app as slackRoutes };
