/**
 * GitHub PR review tools — list, create, update, submit, dismiss PR reviews
 * and list PR review comments.
 * Mirrors agent/tools/github_review.py
 */

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { resolveGithubToken } from "../utils/auth.js";

const GITHUB_API_BASE = "https://api.github.com";

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getRepoAndToken(config: RunnableConfig) {
  const configurable = config?.configurable ?? {};
  const threadId = configurable.thread_id as string;
  const repo = configurable.repo as { owner: string; name: string };
  const [token] = await resolveGithubToken({}, threadId);
  return { repo, token };
}

// ─── List PR reviews ──────────────────────────────────────────────────────────

export const listPrReviews = tool(
  async ({ prNumber }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`,
      { headers: githubHeaders(token) },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true, reviews: data } : { error: data, status: "error" });
  },
  {
    name: "list_pr_reviews",
    description: "List all reviews on a pull request.",
    schema: z.object({ prNumber: z.number().int().describe("The pull request number.") }),
  },
);

// ─── Get single PR review ─────────────────────────────────────────────────────

export const getPrReview = tool(
  async ({ prNumber, reviewId }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews/${reviewId}`,
      { headers: githubHeaders(token) },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true, review: data } : { error: data, status: "error" });
  },
  {
    name: "get_pr_review",
    description: "Get a specific review on a pull request.",
    schema: z.object({
      prNumber: z.number().int().describe("The pull request number."),
      reviewId: z.number().int().describe("The review ID."),
    }),
  },
);

// ─── Create (draft) PR review ─────────────────────────────────────────────────

export const createPrReview = tool(
  async ({ prNumber, body, event }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body, event }),
      },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true, review: data } : { error: data, status: "error" });
  },
  {
    name: "create_pr_review",
    description: "Create a review on a pull request.",
    schema: z.object({
      prNumber: z.number().int().describe("The pull request number."),
      body: z.string().describe("The review body text."),
      event: z
        .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT", "PENDING"])
        .describe("The review event type."),
    }),
  },
);

// ─── Submit a pending review ──────────────────────────────────────────────────

export const submitPrReview = tool(
  async ({ prNumber, reviewId, body, event }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews/${reviewId}/events`,
      {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body, event }),
      },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true, review: data } : { error: data, status: "error" });
  },
  {
    name: "submit_pr_review",
    description: "Submit a pending pull request review.",
    schema: z.object({
      prNumber: z.number().int().describe("The pull request number."),
      reviewId: z.number().int().describe("The review ID to submit."),
      body: z.string().describe("The review body."),
      event: z
        .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
        .describe("The submit event type."),
    }),
  },
);

// ─── Dismiss a review ────────────────────────────────────────────────────────

export const dismissPrReview = tool(
  async ({ prNumber, reviewId, message }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true } : { error: data, status: "error" });
  },
  {
    name: "dismiss_pr_review",
    description: "Dismiss a pull request review.",
    schema: z.object({
      prNumber: z.number().int().describe("The pull request number."),
      reviewId: z.number().int().describe("The review ID to dismiss."),
      message: z.string().describe("The reason for dismissal."),
    }),
  },
);

// ─── List review comments ────────────────────────────────────────────────────

export const listPrReviewComments = tool(
  async ({ prNumber }, config: RunnableConfig) => {
    const { repo, token } = await getRepoAndToken(config);
    const resp = await fetch(
      `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`,
      { headers: githubHeaders(token) },
    );
    const data = await resp.json();
    return JSON.stringify(resp.ok ? { success: true, comments: data } : { error: data, status: "error" });
  },
  {
    name: "list_pr_review_comments",
    description: "List all inline review comments on a pull request.",
    schema: z.object({ prNumber: z.number().int().describe("The pull request number.") }),
  },
);
