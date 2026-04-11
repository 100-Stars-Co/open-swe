/**
 * Open SWE Thread Monitor - Dashboard JavaScript
 */

// State
let threads = [];
let autoRefresh = true;
let refreshInterval = null;
const REFRESH_MS = 5000;

// Sorting state
let sortColumn = null;
let sortDirection = "asc";

// DOM Elements
const threadTableBody = document.getElementById("threadTableBody");
const emptyState = document.getElementById("emptyState");
const refreshBtn = document.getElementById("refreshBtn");
const autoRefreshToggle = document.getElementById("autoRefreshToggle");
const lastUpdated = document.getElementById("lastUpdated");
const statusFilter = document.getElementById("statusFilter");
const sourceFilter = document.getElementById("sourceFilter");
const searchInput = document.getElementById("searchInput");
const detailPanel = document.getElementById("detailPanel");
const closeDetail = document.getElementById("closeDetail");
const detailContent = document.getElementById("detailContent");
const loadingOverlay = document.getElementById("loadingOverlay");

// Summary elements
const activeCount = document.getElementById("activeCount");
const idleCount = document.getElementById("idleCount");
const errorCount = document.getElementById("errorCount");
const totalCount = document.getElementById("totalCount");

// Icons
const SOURCE_ICONS = {
  github: `<svg class="source-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`,
  jira: `<svg class="source-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.252H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z"/></svg>`,
  telegram: `<svg class="source-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.298.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`,
  unknown: `<svg class="source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

// Initialize
function init() {
  setupEventListeners();
  loadThreads();
  startAutoRefresh();
}

// Event Listeners
function setupEventListeners() {
  refreshBtn.addEventListener("click", () => {
    refreshBtn.classList.add("spinning");
    loadThreads().then(() => {
      setTimeout(() => refreshBtn.classList.remove("spinning"), 500);
    });
  });

  autoRefreshToggle.addEventListener("click", () => {
    autoRefresh = !autoRefresh;
    autoRefreshToggle.classList.toggle("active", autoRefresh);
    if (autoRefresh) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  statusFilter.addEventListener("change", renderThreads);
  sourceFilter.addEventListener("change", renderThreads);
  searchInput.addEventListener("input", debounce(renderThreads, 300));

  // Sort column headers
  for (const th of document.querySelectorAll(".thread-table th[data-sort]")) {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const column = th.dataset.sort;
      if (sortColumn === column) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortColumn = column;
        sortDirection = "desc";
      }
      updateSortIndicators();
      renderThreads();
    });
  }

  closeDetail.addEventListener("click", closeDetailPanel);
  detailPanel.addEventListener("click", (e) => {
    if (e.target === detailPanel) closeDetailPanel();
  });
}

// Update visual indicators for sorted column
function updateSortIndicators() {
  for (const th of document.querySelectorAll(".thread-table th[data-sort]")) {
    const column = th.dataset.sort;
    th.style.position = "relative";
    th.style.paddingRight = "1.5rem";
    // Remove existing indicator
    const existing = th.querySelector(".sort-indicator");
    if (existing) existing.remove();

    if (sortColumn === column) {
      const indicator = document.createElement("span");
      indicator.className = "sort-indicator";
      indicator.textContent = sortDirection === "asc" ? " ↑" : " ↓";
      indicator.style.position = "absolute";
      indicator.style.right = "0.5rem";
      indicator.style.color = "var(--accent-blue)";
      th.appendChild(indicator);
    }
  }
}

// Auto Refresh
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    if (document.visibilityState === "visible") {
      loadThreads();
    }
  }, REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// API Calls
async function getErrorMessage(response, fallbackMessage) {
  try {
    const data = await response.json();
    if (typeof data?.error === "string" && data.error.trim()) return data.error;
    if (typeof data?.message === "string" && data.message.trim()) return data.message;
  } catch {
    // Ignore parse failures and use the fallback below.
  }
  return fallbackMessage;
}

async function getErrorPayload(response, fallbackMessage) {
  try {
    const data = await response.json();
    return {
      message:
        (typeof data?.error === "string" && data.error.trim()) ||
        (typeof data?.message === "string" && data.message.trim()) ||
        fallbackMessage,
      canForceDelete: data?.canForceDelete === true,
      cleanupFailed: data?.cleanupFailed === true,
    };
  } catch {
    return {
      message: fallbackMessage,
      canForceDelete: false,
      cleanupFailed: false,
    };
  }
}

async function loadThreads() {
  try {
    const response = await fetch("/api/threads");
    if (!response.ok) {
      throw new Error(await getErrorMessage(response, "Failed to fetch threads"));
    }
    const data = await response.json();
    threads = data.threads || [];
    updateSummary();
    renderThreads();
    updateLastUpdated();
  } catch (error) {
    console.error("Error loading threads:", error);
    showError(error instanceof Error ? error.message : "Failed to load threads. Please try again.");
  }
}

async function loadThreadDetail(threadId) {
  showLoading(true);
  try {
    const [threadRes, runsRes] = await Promise.all([
      fetch(`/api/threads/${threadId}`),
      fetch(`/api/threads/${threadId}/runs`),
    ]);

    if (!threadRes.ok) {
      throw new Error(await getErrorMessage(threadRes, "Thread not found"));
    }

    const thread = await threadRes.json();
    const runs = runsRes.ok ? (await runsRes.json()).runs : [];

    renderDetailPanel(thread, runs);
    openDetailPanel();
  } catch (error) {
    console.error("Error loading thread detail:", error);
    showError(
      error instanceof Error ? error.message : "Failed to load thread details. Please try again.",
    );
  } finally {
    showLoading(false);
  }
}

async function deleteThread(threadId) {
  if (!confirm(`Are you sure you want to delete thread ${threadId.slice(0, 8)}...?\n\nThis will remove the thread from LangGraph and clean up associated sandbox data. This action cannot be undone.`)) {
    return;
  }

  showLoading(true);
  try {
    let response = await fetch(`/api/threads/${threadId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const errorPayload = await getErrorPayload(response, "Failed to delete thread");

      if (errorPayload.canForceDelete && errorPayload.cleanupFailed) {
        const confirmed = confirm(
          `${errorPayload.message}\n\nDelete the thread anyway?\nThis will remove the thread record, but the sandbox may remain orphaned and require manual cleanup.`,
        );

        if (!confirmed) {
          throw new Error(errorPayload.message);
        }

        response = await fetch(`/api/threads/${threadId}?force=true`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(await getErrorMessage(response, "Failed to force delete thread"));
        }
      } else {
        throw new Error(errorPayload.message);
      }
    }

    // Close detail panel if open
    closeDetailPanel();

    // Refresh thread list
    await loadThreads();
  } catch (error) {
    console.error("Error deleting thread:", error);
    showError(
      error instanceof Error ? error.message : "Failed to delete thread. Please try again.",
    );
  } finally {
    showLoading(false);
  }
}

async function stopThread(threadId) {
  if (!confirm(`Are you sure you want to stop thread ${threadId.slice(0, 8)}...?\n\nThis will interrupt any active runs for this thread.`)) {
    return;
  }

  showLoading(true);
  try {
    const response = await fetch(`/api/threads/${threadId}/stop`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, "Failed to stop thread"));
    }

    const result = await response.json();
    alert(result.message);

    // Refresh thread list
    await loadThreads();
  } catch (error) {
    console.error("Error stopping thread:", error);
    showError(error instanceof Error ? error.message : "Failed to stop thread. Please try again.");
  } finally {
    showLoading(false);
  }
}

// Render Functions
function updateSummary() {
  const counts = threads.reduce(
    (acc, t) => {
      acc.total++;
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );

  activeCount.textContent = counts.busy || 0;
  idleCount.textContent = counts.idle || 0;
  errorCount.textContent = counts.error || 0;
  totalCount.textContent = counts.total;
}

function renderThreads() {
  const status = statusFilter.value;
  const source = sourceFilter.value;
  const search = searchInput.value.toLowerCase();

  const filtered = threads.filter((t) => {
    if (status && t.status !== status) return false;
    if (source && t.metadata?.source !== source) return false;
    if (search) {
      const searchText = [
        t.threadId,
        t.metadata?.repo?.owner,
        t.metadata?.repo?.name,
        t.metadata?.branchName,
        t.metadata?.sandboxId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!searchText.includes(search)) return false;
    }
    return true;
  });

  // Sort by selected column or default (status: busy first, then by threadId)
  filtered.sort((a, b) => {
    let comparison = 0;

    if (sortColumn === "createdAt") {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      comparison = aTime - bTime;
    } else if (sortColumn === "threadId") {
      comparison = a.threadId.localeCompare(b.threadId);
    } else if (sortColumn === "source") {
      const aSource = a.metadata?.source || "";
      const bSource = b.metadata?.source || "";
      comparison = aSource.localeCompare(bSource);
    } else if (sortColumn === "status") {
      const order = { busy: 0, idle: 1, interrupted: 2, error: 3 };
      const aOrder = order[a.status] ?? 4;
      const bOrder = order[b.status] ?? 4;
      comparison = aOrder - bOrder;
    } else {
      // Default: status (busy first) then by threadId desc
      if (a.status === "busy" && b.status !== "busy") return -1;
      if (a.status !== "busy" && b.status === "busy") return 1;
      return b.threadId.localeCompare(a.threadId);
    }

    return sortDirection === "desc" ? -comparison : comparison;
  });

  if (filtered.length === 0) {
    threadTableBody.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  threadTableBody.innerHTML = filtered.map((thread) => createThreadRow(thread)).join("");

  // Add click handlers
  for (const row of document.querySelectorAll(".thread-row")) {
    row.addEventListener("click", (e) => {
      if (!e.target.closest(".action-btn")) {
        const threadId = row.dataset.threadId;
        loadThreadDetail(threadId);
      }
    });
  }
}

function createThreadRow(thread) {
  const source = thread.metadata?.source || "unknown";
  const repo = thread.metadata?.repo;
  const shortId = thread.threadId.slice(0, 8);
  const sandboxId = thread.metadata?.sandboxId;
  const branchName = thread.metadata?.branchName;
  const baseBranch = thread.metadata?.baseBranch;
  const createdAt = thread.createdAt ? formatTime(thread.createdAt) : "Unknown";

  let sourceLink = "";
  if (source === "github" && repo && thread.metadata?.issue_number) {
    sourceLink = `https://github.com/${repo.owner}/${repo.name}/issues/${thread.metadata.issue_number}`;
  } else if (source === "jira" && thread.metadata?.jira_issue_key) {
    const jiraBase = "https://"; // Could be configured
    sourceLink = `${jiraBase}/browse/${thread.metadata.jira_issue_key}`;
  }

  return `
    <tr class="thread-row" data-thread-id="${thread.threadId}">
      <td>
        <span class="thread-id" title="${thread.threadId}">${shortId}...</span>
      </td>
      <td>
        <div class="source-cell">
          ${SOURCE_ICONS[source] || SOURCE_ICONS.unknown}
          ${
            sourceLink
              ? `<a href="${sourceLink}" target="_blank" class="source-link" title="Open in ${source}">${source}</a>`
              : `<span>${source}</span>`
          }
        </div>
      </td>
      <td>
        <span class="status-badge ${thread.status}">${thread.status}</span>
      </td>
      <td class="created-at-cell" title="${thread.createdAt || ""}">${createdAt}</td>
      <td class="metadata-cell">
        ${
          sandboxId
            ? `
          <div class="metadata-item">
            <span class="metadata-label">Sandbox:</span>
            <span class="metadata-value">${sandboxId.slice(0, 12)}...</span>
          </div>
        `
            : ""
        }
        ${
          branchName
            ? `
          <div class="metadata-item">
            <span class="metadata-label">Branch:</span>
            <span class="metadata-value">${branchName}</span>
          </div>
        `
            : ""
        }
        ${
          baseBranch && baseBranch !== branchName
            ? `
          <div class="metadata-item">
            <span class="metadata-label">Base:</span>
            <span class="metadata-value">${baseBranch}</span>
          </div>
        `
            : ""
        }
        ${
          repo
            ? `
          <div class="metadata-item">
            <span class="metadata-label">Repo:</span>
            <span class="metadata-value">${repo.owner}/${repo.name}</span>
          </div>
        `
            : ""
        }
      </td>
      <td class="actions-cell">
        <button class="action-btn primary" onclick="event.stopPropagation(); loadThreadDetail('${thread.threadId}')">
          Details
        </button>
        ${
          sourceLink
            ? `
          <a href="${sourceLink}" target="_blank" class="action-btn" title="Open source" onclick="event.stopPropagation()">
            Open
          </a>
        `
            : ""
        }
        ${
          thread.status === "busy"
            ? `
          <button class="action-btn" style="color: var(--accent-yellow); border-color: var(--accent-yellow);" onclick="event.stopPropagation(); stopThread('${thread.threadId}')" title="Stop running thread">
            Stop
          </button>
        `
            : ""
        }
        <button class="action-btn" style="color: var(--accent-red); border-color: var(--accent-red);" onclick="event.stopPropagation(); deleteThread('${thread.threadId}')" title="Delete thread">
          Delete
        </button>
      </td>
    </tr>
  `;
}

function renderDetailPanel(thread, runs) {
  const source = thread.metadata?.source || "unknown";
  const repo = thread.metadata?.repo;
  const sandboxId = thread.metadata?.sandboxId;

  let sourceInfo = "";
  if (source === "github" && thread.metadata?.issue_number) {
    sourceInfo = `
      <div class="detail-row">
        <span class="detail-label">Issue</span>
        <span class="detail-value">
          <a href="https://github.com/${repo.owner}/${repo.name}/issues/${thread.metadata.issue_number}" target="_blank">
            #${thread.metadata.issue_number}
          </a>
        </span>
      </div>
    `;
  } else if (source === "jira" && thread.metadata?.jira_issue_key) {
    sourceInfo = `
      <div class="detail-row">
        <span class="detail-label">Jira Issue</span>
        <span class="detail-value">${thread.metadata.jira_issue_key}</span>
      </div>
    `;
  } else if (source === "telegram") {
    const chat = thread.metadata?.telegram_chat;
    if (chat) {
      sourceInfo = `
        <div class="detail-row">
          <span class="detail-label">Telegram Chat</span>
          <span class="detail-value">${chat.chat_id}</span>
        </div>
      `;
    }
  }

  const runsHtml =
    runs.length > 0
      ? runs
          .map(
            (run) => `
        <div class="timeline-item">
          <div class="timeline-dot ${run.status === "success" ? "success" : run.status === "error" ? "error" : ""}"></div>
          <div class="timeline-content">
            <div class="timeline-title">Run ${run.runId.slice(0, 8)} - ${run.status}</div>
            <div class="timeline-time">${run.createdAt ? formatTime(run.createdAt) : "Unknown"}</div>
            ${run.traceUrl ? `<div><a href="${run.traceUrl}" target="_blank">View Trace</a></div>` : ""}
          </div>
        </div>
      `,
          )
          .join("")
      : '<p style="color: var(--text-secondary);">No runs recorded</p>';

  detailContent.innerHTML = `
    <div class="detail-section">
      <h3 class="detail-section-title">Thread Information</h3>
      <div class="detail-row">
        <span class="detail-label">Thread ID</span>
        <span class="detail-value">${thread.threadId}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <span class="detail-value">
          <span class="status-badge ${thread.status}">${thread.status}</span>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Source</span>
        <span class="detail-value">${source}</span>
      </div>
      ${sourceInfo}
    </div>

    <div class="detail-section">
      <h3 class="detail-section-title">Sandbox & Repository</h3>
      <div class="detail-row">
        <span class="detail-label">Sandbox ID</span>
        <span class="detail-value">${sandboxId || "N/A"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Repository</span>
        <span class="detail-value">${repo ? `${repo.owner}/${repo.name}` : "N/A"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Branch</span>
        <span class="detail-value">${thread.metadata?.branchName || "N/A"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Base Branch</span>
        <span class="detail-value">${thread.metadata?.baseBranch || "N/A"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Repo Directory</span>
        <span class="detail-value">${thread.metadata?.repoDir || "N/A"}</span>
      </div>
    </div>

    ${
      thread.queuedMessages?.length > 0
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Queued Messages (${thread.queuedMessages.length})</h3>
        <div style="background: var(--bg-tertiary); padding: 1rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.75rem; white-space: pre-wrap;">
          ${thread.queuedMessages.map((m) => JSON.stringify(m, null, 2)).join("\n---\n")}
        </div>
      </div>
    `
        : ""
    }

    <div class="detail-section">
      <h3 class="detail-section-title">Run History</h3>
      <div class="timeline">
        ${runsHtml}
      </div>
    </div>

    <div class="detail-section">
      <h3 class="detail-section-title">Actions</h3>
      ${
        thread.status === "busy"
          ? `
        <button class="action-btn" style="color: var(--accent-yellow); border-color: var(--accent-yellow); width: 100%; padding: 0.75rem; margin-bottom: 0.5rem;" onclick="stopThread('${thread.threadId}')">
          Stop Thread
        </button>
      `
          : ""
      }
      <button class="action-btn" style="color: var(--accent-red); border-color: var(--accent-red); width: 100%; padding: 0.75rem;" onclick="deleteThread('${thread.threadId}')">
        Delete Thread
      </button>
    </div>
  `;
}

// Panel Controls
function openDetailPanel() {
  detailPanel.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeDetailPanel() {
  detailPanel.classList.remove("active");
  document.body.style.overflow = "";
}

// Utilities
function updateLastUpdated() {
  const now = new Date();
  lastUpdated.textContent = `Updated ${now.toLocaleTimeString()}`;
}

function showLoading(show) {
  loadingOverlay.classList.toggle("active", show);
}

function showError(message) {
  console.error(message);
  alert(message);
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Start
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
