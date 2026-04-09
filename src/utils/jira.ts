/**
 * Jira REST API helpers.
 * Mirrors agent/utils/jira.py
 */

function jiraHeaders(): Record<string, string> {
  const email = process.env.JIRA_USER_EMAIL ?? "";
  const token = process.env.JIRA_API_TOKEN ?? "";
  const credentials = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function jiraBaseUrl(): string {
  const url = process.env.JIRA_BASE_URL;
  if (!url) throw new Error("JIRA_BASE_URL environment variable is not set.");
  return url.replace(/\/$/, "");
}

async function jiraRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${jiraBaseUrl()}/rest/api/3${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: { ...jiraHeaders(), ...(options.headers as Record<string, string>) },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jira API error ${resp.status} for ${path}: ${text}`);
  }

  if (resp.status === 204) return {} as T;
  return resp.json() as Promise<T>;
}

// ─── Issue operations ─────────────────────────────────────────────────────────

export async function getIssue(issueKey: string): Promise<Record<string, unknown>> {
  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}`);
}

export async function searchIssues(jql: string): Promise<Record<string, unknown>> {
  return jiraRequest(`/search?jql=${encodeURIComponent(jql)}&maxResults=50`);
}

export interface CreateIssueParams {
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
}

export async function createIssue(params: CreateIssueParams): Promise<Record<string, unknown>> {
  const { projectKey, summary, description, issueType = "Task", priority, assignee, labels } =
    params;

  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType },
  };

  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }
  if (priority) fields.priority = { name: priority };
  if (assignee) fields.assignee = { accountId: assignee };
  if (labels?.length) fields.labels = labels;

  return jiraRequest("/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

export interface UpdateIssueParams {
  issueKey: string;
  summary?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
}

export async function updateIssue(params: UpdateIssueParams): Promise<Record<string, unknown>> {
  const { issueKey, summary, description, priority, assignee, labels } = params;
  const fields: Record<string, unknown> = {};

  if (summary) fields.summary = summary;
  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }
  if (priority) fields.priority = { name: priority };
  if (assignee) fields.assignee = { accountId: assignee };
  if (labels) fields.labels = labels;

  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

export async function addComment(issueKey: string, comment: string): Promise<Record<string, unknown>> {
  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
      },
    }),
  });
}

export async function getTransitions(issueKey: string): Promise<Record<string, unknown>> {
  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}/transitions`);
}

export async function transitionIssue(
  issueKey: string,
  transitionId: string,
  comment?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { transition: { id: transitionId } };
  if (comment) {
    body.update = {
      comment: [
        {
          add: {
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
            },
          },
        },
      ],
    };
  }
  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
