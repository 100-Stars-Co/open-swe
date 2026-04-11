
# Installation Guide

This guide walks you through setting up Open SWE end-to-end: local development, GitHub App creation, Langfuse tracing, webhooks, and production deployment.

> **The steps are ordered to avoid forward references.** Each step only depends on things you've already completed.

## Prerequisites

- **Python 3.11 – 3.13** (3.14 is not yet supported due to dependency constraints)
- [uv](https://docs.astral.sh/uv/) package manager
- [LangGraph CLI](https://langchain-ai.github.io/langgraph/cloud/reference/cli/)
- [ngrok](https://ngrok.com/) (for local development — exposes webhook endpoints to the internet)

## 1. Clone and install

```bash
git clone https://github.com/langchain-ai/open-swe.git
cd open-swe
uv venv
source .venv/bin/activate
uv sync --all-extras
```

## 2. Start ngrok

You'll need the ngrok URL in subsequent steps when configuring webhooks, so start it first.

```bash
ngrok http 2024 --url https://some-url-you-configure.ngrok.dev
```

You don't need to pass the `--url` flag, however doing so will use the same subdomain each time you startup the server. Without this, you'll need to update the webhook URL in GitHub, Slack and Linear every time you restart your server for local development.

Copy the HTTPS URL you set, or if you didn't pass `--url`, the one ngrok gives you. You'll paste this into the webhook settings in steps 3 and 5.

> Keep this terminal open — ngrok needs to stay running during local development. Use a second terminal for the rest of the steps.

## 3. Create a GitHub App

Open SWE authenticates as a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) to clone repos, push branches, and open PRs.

### 3a. Choose your OAuth provider ID

Before creating the app you need to decide on an **OAuth provider ID** — this is a short string you'll use in both GitHub and LangSmith to link the two. Pick something memorable, for example:

```
github-oauth-provider
```

Write this down. You'll use it in the callback URL below and again in step 4 when configuring the tracing and OAuth setup.

### 3b. Create the app

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **App name**: `open-swe` (or your preferred name)
   - **Homepage URL**: This can be any valid URL — it's only shown on the GitHub Marketplace page (which you won't be using). Use something like `https://github.com/langchain-ai/open-swe`
   - **Callback URL**: `https://smith.langchain.com/host-oauth-callback/<your-provider-id>` — replace `<your-provider-id>` with the ID you chose in step 3a (e.g. `https://smith.langchain.com/host-oauth-callback/github-oauth-provider`)
   - **Request user authorization (OAuth) during installation**: ✅ Enable this
   - **Webhook URL**: `https://<your-ngrok-url>/webhooks/github` — use the ngrok URL from step 2
   - **Webhook secret**: generate one and save it — you'll need it later as `GITHUB_WEBHOOK_SECRET`:
     ```bash
     openssl rand -hex 32
     ```
3. Set permissions:
   - **Repository permissions**:
     - Contents: Read & write
     - Pull requests: Read & write
     - Issues: Read & write
     - Metadata: Read-only
4. Under **Subscribe to events**, enable:
   - `Issue comment`
   - `Pull request review`
   - `Pull request review comment`
5. Click **Create GitHub App**

### 3c. Collect credentials

After creating the app:

1. **App ID** — shown at the top of the app's settings page. Save this as `GITHUB_APP_ID`.
2. **Private key** — scroll down to **Private keys** → click **Generate a private key**. A `.pem` file will download. Save its contents as `GITHUB_APP_PRIVATE_KEY`.

### 3d. Install the app on your repositories

1. From your app's settings page, click **Install App** in the sidebar
2. Select your org or personal account
3. Choose which repositories Open SWE should have access to
4. Click **Install**
5. After installation, look at the URL in your browser — it will look like:
   ```
   https://github.com/settings/installations/12345678
   ```
   or for an org:
   ```
   https://github.com/organizations/YOUR-ORG/settings/installations/12345678
   ```
   The number at the end (`12345678`) is your **Installation ID**. Save this as `GITHUB_APP_INSTALLATION_ID`.

> **Note**: The installation page may prompt you to authenticate with LangSmith. If you haven't set up the OAuth provider yet (step 4), that's fine — you can still grab the Installation ID from the URL and complete the setup later.

## 4. Set up Langfuse tracing

Open SWE uses [Langfuse](https://langfuse.com/) for tracing:
- **Tracing**: all agent runs are logged for debugging and observability
- **Trace links**: comments and PR footers point to Langfuse traces

If you also use LangSmith sandboxes, keep the sandbox-related variables below and in the sandbox section.

### 4a. Get your Langfuse API key and project ID

1. Create a [Langfuse account](https://langfuse.com/) if you don't have one
2. Go to **Settings → API Keys → Create API Key**
3. Save the public and secret keys as `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`
4. Get your **Project ID** from the Langfuse project settings and save it as `LANGFUSE_PROJECT_ID`
5. If you self-host Langfuse, set `LANGFUSE_BASE_URL` or `LANGFUSE_HOST` to your deployment URL

### 4b. Configure GitHub OAuth (optional but recommended)

This lets each user authenticate with their own GitHub account. Without it, all operations use the GitHub App's installation token (a shared bot identity).

**What this affects:**
- **With per-user OAuth**: PRs and commits show the triggering user's identity; each user's GitHub permissions are respected
- **Without it (bot-token-only mode)**: all PRs and commits appear as the GitHub App bot; the app's installation-level permissions are used for everything

To set up per-user OAuth:

1. In LangSmith, go to **Settings → OAuth Providers → Add Provider**
2. Set the **Provider ID** to the same string you chose in step 3a (e.g. `github-oauth-provider`)
3. Enter the **Client ID** and **Client Secret** from your GitHub App (found on the GitHub App settings page under **OAuth credentials**)
4. Save. You'll reference this Provider ID as `GITHUB_OAUTH_PROVIDER_ID` in your environment variables.

### 4c. Sandbox templates (optional)

LangSmith sandboxes provide the isolated execution environment for each agent run. You can create a template using the same Docker image we use internally by visiting the sandbox page in LangSmith, and setting the following fields:

- `Name`: you can set this to whatever name you'd like, e.g. `open-swe`
- `Container Image`: `bracelangchain/deepagents-sandbox:v1` this contains the [Docker file in this repo](./Dockerfile)
- `CPU`: `500m`
- `Memory`: `4096Mi`
- `Ephemeral Storage`: `15Gi`

> If you don't set these, you can use a Python based docker image in the template.

## 5. Set up triggers

Open SWE can be triggered from GitHub, Linear, and/or Slack. **Configure whichever surfaces your team uses — you don't need all of them.**

### GitHub

GitHub triggering works automatically once your GitHub App is set up (step 3). Users can:
- Tag `@openswe` in issue titles or bodies to start a task
- Tag `@openswe` in issue comments for follow-up instructions
- Tag `@openswe` in PR review comments to have it address review feedback

To control which GitHub users can trigger the agent, add them to the `GITHUB_USER_EMAIL_MAP` in `agent/utils/github_user_email_map.py`:

```python
GITHUB_USER_EMAIL_MAP = {
    "their-github-username": "their-email@example.com",
}
```

You should also add the GitHub organization which should be allowed to be triggered from in GitHub:

`agent/webapp.py`
```python
ALLOWED_GITHUB_ORGS = "langchain-ai,anthropics"
```

### Linear (optional)

Open SWE listens for Linear comments that mention `@openswe`.

**Create a webhook:**

1. In Linear, go to **Settings → API → Webhooks → New webhook**
2. Fill in:
   - **Label**: `open-swe`
   - **URL**: `https://<your-ngrok-url>/webhooks/linear` — use the ngrok URL from step 2
   - **Secret**: generate with `openssl rand -hex 32` — save this as `LINEAR_WEBHOOK_SECRET`
3. Under **Data change events**, enable **Comments → Create** only
4. Click **Create webhook**

**Get your API key:**

1. Go to **Settings → API → Personal API keys → New API key**
2. Name it `open-swe`, select **All access**, and copy the key
3. Save it as `LINEAR_API_KEY`

**Configure team-to-repo mapping:**

Open SWE routes Linear issues to GitHub repos based on the Linear team and project. Edit the mapping in `agent/utils/linear_team_repo_map.py`:

```python
LINEAR_TEAM_TO_REPO = {
    "My Team": {"owner": "my-org", "name": "my-repo"},
    "Engineering": {
        "projects": {
            "backend": {"owner": "my-org", "name": "backend"},
            "frontend": {"owner": "my-org", "name": "frontend"},
        },
        "default": {"owner": "my-org", "name": "monorepo"},
    },
}
```

Users can also override the team/project mapping per-comment by including `repo:owner/name` (or a GitHub URL) in their `@openswe` comment. The mapping is used as a fallback when no repo is specified in the comment text.

### Slack (optional)

**Create a Slack App:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Copy the manifest below, replacing the two placeholder URLs:
   - Replace `<your-provider-id>` with the OAuth provider ID from step 3a
   - Replace `<your-ngrok-url>` with the ngrok URL from step 2

<details>
<summary>Slack App Manifest</summary>

```json
{
    "display_information": {
        "name": "Open SWE",
        "description": "Enables Open SWE to interact with your workspace",
        "background_color": "#000000"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": "Open SWE",
            "always_online": true
        }
    },
    "oauth_config": {
        "redirect_urls": [
            "https://smith.langchain.com/host-oauth-callback/<your-provider-id>"
        ],
        "scopes": {
            "bot": [
                "reactions:write",
                "app_mentions:read",
                "channels:history",
                "channels:read",
                "chat:write",
                "groups:history",
                "groups:read",
                "im:history",
                "im:read",
                "im:write",
                "mpim:history",
                "mpim:read",
                "team:read",
                "users:read",
                "users:read.email"
            ]
        }
    },
    "settings": {
        "event_subscriptions": {
            "request_url": "https://<your-ngrok-url>/webhooks/slack",
            "bot_events": [
                "app_mention",
                "message.im",
                "message.mpim"
            ]
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": false,
        "token_rotation_enabled": false
    }
}
```

</details>

3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)

**Credentials you'll need:**

- `SLACK_BOT_TOKEN`: the Bot User OAuth Token (`xoxb-...`)
- `SLACK_SIGNING_SECRET`: found under **Basic Information → App Credentials**
- `SLACK_BOT_USER_ID`: the bot's user ID (find it in Slack by clicking the bot's profile)
- `SLACK_BOT_USERNAME`: the bot's display name (e.g. `open-swe`)

**Default repo:**

Slack messages are routed to the default repo (`DEFAULT_REPO_OWNER`/`DEFAULT_REPO_NAME` — see step 6) unless the user specifies one with `repo:owner/name` in their message.

## 6. Environment variables

Create a `.env` file in the project root. Below is the full list — only fill in the sections relevant to the triggers you configured.

```bash
# === Langfuse tracing ===
LANGFUSE_PUBLIC_KEY=""                 # From step 4a
LANGFUSE_SECRET_KEY=""                 # From step 4a
LANGFUSE_PROJECT_ID=""                 # From step 4a
LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # Optional self-hosted override
LANGFUSE_HOST=""                       # Optional self-hosted alias

# === LangSmith sandboxes (optional) ===
LANGSMITH_API_KEY_PROD=""              # From sandbox setup
LANGSMITH_TENANT_ID_PROD=""
LANGSMITH_TRACING_PROJECT_ID_PROD=""
LANGSMITH_URL_PROD="https://smith.langchain.com"

# === LLM ===
ANTHROPIC_API_KEY=""                   # Anthropic API key (default provider)

# === GitHub App (required) ===
GITHUB_APP_ID=""                       # From step 3c
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
"
GITHUB_APP_INSTALLATION_ID=""          # From step 3d

# === GitHub Webhook (required) ===
GITHUB_WEBHOOK_SECRET=""               # The secret you generated in step 3b

# === GitHub OAuth via LangSmith (optional) ===
# Without these, all operations use the GitHub App's bot token.
# With these, each user authenticates with their own GitHub account.
GITHUB_OAUTH_PROVIDER_ID=""            # The provider ID from steps 3a / 4b

# === Org Allowlist (optional) ===
# Comma-separated list of GitHub orgs the agent is allowed to operate on.
# Leave empty to allow all orgs.
ALLOWED_GITHUB_ORGS=""                 # e.g. "my-org,my-other-org"

# === Default Repository ===
# Used across all triggers when no repo is specified.
DEFAULT_REPO_OWNER=""                  # Default GitHub org (e.g. "my-org")
DEFAULT_REPO_NAME=""                   # Default GitHub repo (e.g. "my-repo")

# === Linear (if using Linear trigger) ===
LINEAR_API_KEY=""                      # From step 5
LINEAR_WEBHOOK_SECRET=""               # From step 5

# === Slack (if using Slack trigger) ===
SLACK_BOT_TOKEN=""                     # From step 5
SLACK_BOT_USER_ID=""
SLACK_BOT_USERNAME=""
SLACK_SIGNING_SECRET=""

# === Telegram (if using Telegram trigger) ===
TELEGRAM_BOT_TOKEN=""                  # Bot token from @BotFather
TELEGRAM_BOT_USERNAME=""               # Bot username without the @
TELEGRAM_WEBHOOK_SECRET=""             # Secret configured when setting the webhook
TELEGRAM_REPO_OWNER=""                 # Fallback GitHub org for Telegram messages
TELEGRAM_REPO_NAME=""                  # Fallback GitHub repo for Telegram messages

# === Exa (optional — enables web search tool) ===
EXA_API_KEY=""                         # From https://dashboard.exa.ai

# === Sandbox (optional) ===
DEFAULT_SANDBOX_TEMPLATE_NAME=""       # Custom sandbox template name (default: deepagents-cli)
DEFAULT_SANDBOX_TEMPLATE_IMAGE=""      # Custom Docker image (default: python:3)

# === Token Encryption ===
TOKEN_ENCRYPTION_KEY=""                # Generate with: openssl rand -base64 32
```

## 7. Start the server

Make sure ngrok is still running from step 2, then start the API server and worker in separate terminals:

```bash
bun run dev
```

```bash
bun run worker
```

The API server runs on `http://localhost:8000` with these endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/github` | GitHub issue/PR/comment webhooks |
| `POST /webhooks/linear` | Linear comment webhooks |
| `GET /webhooks/linear` | Linear webhook verification |
| `POST /webhooks/slack` | Slack event webhooks |
| `GET /webhooks/slack` | Slack webhook verification |
| `POST /webhooks/telegram` | Telegram bot webhooks |
| `GET /webhooks/telegram` | Telegram webhook verification |
| `GET /health` | Health check |

## 8. Verify it works

### GitHub

1. Go to any issue in a repository where the app is installed
2. Create or comment on an issue with: `@openswe what files are in this repo?`
3. You should see:
   - A 👀 reaction on your comment within a few seconds
   - A new trace in your Langfuse project
   - The agent replies with a comment on the issue

### Linear

1. Go to any Linear issue in a team you configured in `LINEAR_TEAM_TO_REPO`
2. Add a comment: `@openswe what files are in this repo?`
3. You should see:
   - A 👀 reaction on your comment within a few seconds
   - A new trace in your Langfuse project
   - The agent replies with a comment on the issue

### Slack

1. In any channel where the bot is invited, start a thread
2. Mention the bot: `@open-swe what's in the repo?`
3. You should see:
   - An 👀 reaction on your message
   - A reply in the thread with the agent's response

### Telegram

1. Configure your bot webhook to point at `https://<your-url>/webhooks/telegram` with the same secret as `TELEGRAM_WEBHOOK_SECRET`
2. Send the bot a direct message, or mention it in a group: `@your_bot what's in the repo?`
3. You should see:
   - A new trace in your Langfuse project
   - A reply in the same chat
   - If no repo is included in the message, the bot uses `TELEGRAM_REPO_OWNER` / `TELEGRAM_REPO_NAME`

## 9. Production deployment

For production, deploy the Bun API server and the worker as separate processes:

1. Push your code to a GitHub repository
2. Provision Postgres and Redis
3. Set all environment variables from step 6 in the deployment config
4. Run `bun run start` for the API service and `bun run worker` for the background worker
5. Update your webhook URLs (Linear, Slack, Telegram, GitHub App) to point to your production URL (replace the ngrok URL)

## Troubleshooting

### Webhook not receiving events

- Verify ngrok is running and the URL matches what's configured in GitHub/Linear/Slack
- Check the ngrok web inspector at `http://localhost:4040` for incoming requests
- Ensure you enabled the correct event types (Comments → Create for Linear, `app_mention` for Slack, Issues + Issue comment for GitHub)
- **Webhook secrets are required** — if `GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`, or `SLACK_SIGNING_SECRET` is not set, all requests to that endpoint will be rejected with 401

### GitHub authentication errors

- Verify `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID` are set correctly
- Ensure the GitHub App is installed on the target repositories
- Check that the private key includes the full `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines

### LangSmith sandbox creation failures

- Verify `LANGSMITH_API_KEY_PROD` is set and valid
- Check LangSmith sandbox quotas in your workspace settings
- If you see `Failed to check template ''`, ensure either `DEFAULT_SANDBOX_TEMPLATE_NAME` is set or that your LangSmith API key has permissions to create sandbox templates
- If you get a 403 Forbidden error on the sandbox templates endpoint, your LangSmith workspace may not have sandbox access enabled — contact LangSmith support

### Agent not responding to comments

- For GitHub: ensure the comment or issue contains `@openswe` (case-insensitive), and the commenter's GitHub username is in `GITHUB_USER_EMAIL_MAP`
- For Linear: ensure the comment contains `@openswe` (case-insensitive)
- For Slack: ensure the bot is invited to the channel and the message is an `@mention`
- Check server logs for webhook processing errors

### Token encryption errors

- Ensure `TOKEN_ENCRYPTION_KEY` is set (generate with `openssl rand -base64 32`)
- The key must be a valid 32-byte Fernet-compatible base64 string
