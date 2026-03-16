// popup.js

const LOG_PREFIX = "[Moodle Keep-Alive][popup]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

// ---------------------------------------------------------------------------
// Background message helper
// ---------------------------------------------------------------------------
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function showSecretStatus(msg, isError = false) {
  const el = document.getElementById("secretStatus");
  el.textContent = msg;
  el.className = "status-msg" + (isError ? " error" : "");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = "";
  }, 2500);
}

function showImportSummary(text) {
  const el = document.getElementById("importSummary");
  el.textContent = text;
  el.style.display = "block";
}

// ---------------------------------------------------------------------------
// Render session list
// ---------------------------------------------------------------------------
function renderSessions(sessions = {}) {
  const list = document.getElementById("sessionList");
  const entries = Object.entries(sessions);
  log("Render sessions", { count: entries.length });

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-msg">No sessions tracked yet.</div>';
    return;
  }

  list.innerHTML = "";

  for (const [uniqueIdentity, session] of entries) {
    const item = document.createElement("div");
    item.className = "session-item";

    const info = document.createElement("div");
    info.className = "session-info";

    const domainDiv = document.createElement("div");
    domainDiv.className = "session-domain";
    domainDiv.title = session.domain;
    domainDiv.textContent = getHostname(session.domain);

    const userDiv = document.createElement("div");
    userDiv.className = "session-user";
    userDiv.textContent = `User ID: ${session.nonUniqueId}`;

    info.appendChild(domainDiv);
    info.appendChild(userDiv);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeSession(uniqueIdentity));

    item.appendChild(info);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Remove a single session
// ---------------------------------------------------------------------------
async function removeSession(uniqueIdentity) {
  log("Remove session clicked", { uniqueIdentity });
  const { secret, sessions = {} } = await getStorage(["secret", "sessions"]);

  if (secret) {
    try {
      await sendMessage({
        type: "DELETE_SESSION",
        payload: { secret, uniqueIdentity },
      });
    } catch {
      // Network error — remove locally regardless
      warn("DELETE_SESSION request failed; removing locally", {
        uniqueIdentity,
      });
    }
  }

  delete sessions[uniqueIdentity];
  await setStorage({ sessions });
  renderSessions(sessions);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function handleExport() {
  const { sessions = {} } = await getStorage(["sessions"]);
  log("Export sessions", { count: Object.keys(sessions).length });

  const exportData = Object.entries(sessions).map(([uniqueIdentity, s]) => ({
    domain: s.domain,
    uniqueIdentity,
    nonUniqueId: s.nonUniqueId,
    cookieString: s.cookieString,
  }));

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "moodle-sessions-export.json";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function handleImport(file) {
  log("Import started", { filename: file?.name, size: file?.size });
  const summaryEl = document.getElementById("importSummary");
  summaryEl.style.display = "none";
  summaryEl.textContent = "";

  // --- Parse ---
  let text;
  try {
    text = await file.text();
  } catch {
    showImportSummary("Failed to read file.");
    return;
  }

  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    showImportSummary("Invalid file format. Import aborted.");
    return;
  }

  if (!Array.isArray(entries)) {
    showImportSummary("Invalid file format. Import aborted.");
    return;
  }

  if (entries.length === 0) {
    showImportSummary("No sessions found in file.");
    return;
  }

  // Validate all entries have required fields before processing any
  const required = ["domain", "uniqueIdentity", "cookieString", "nonUniqueId"];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      showImportSummary("Invalid file format. Import aborted.");
      return;
    }
    for (const field of required) {
      if (!entry[field]) {
        showImportSummary("Invalid file format. Import aborted.");
        return;
      }
    }
  }

  const { secret, sessions: currentSessions = {} } = await getStorage([
    "secret",
    "sessions",
  ]);
  log("Import storage loaded", {
    hasSecret: Boolean(secret),
    existingSessions: Object.keys(currentSessions).length,
  });

  const successList = [];
  const expiredList = [];
  const serverFailList = [];

  // --- Validate & upsert each entry ---
  for (const entry of entries) {
    const { domain, uniqueIdentity, cookieString, nonUniqueId } = entry;
    const hostname = getHostname(domain);

    // Live cookie validation via background worker
    let valid = false;
    try {
      const result = await sendMessage({
        type: "VALIDATE_COOKIE",
        payload: { domain, cookieString },
      });
      valid = result?.valid === true;
    } catch {
      // Treat network errors as invalid
    }

    if (!valid) {
      warn("Import skipped invalid session", { domain, nonUniqueId });
      expiredList.push({ hostname, nonUniqueId });
      continue;
    }

    // Upsert session locally (create or replace cookieString)
    currentSessions[uniqueIdentity] = { cookieString, domain, nonUniqueId };

    // Sync to backend if access code is configured
    if (secret) {
      let synced = false;
      try {
        const syncResult = await sendMessage({
          type: "POST_SESSION",
          payload: {
            secret,
            uniqueIdentity,
            nonUniqueId,
            domain,
            cookieString,
          },
        });
        synced = syncResult?.ok === true;
      } catch {
        // Treat as sync failure
      }

      if (synced) {
        log("Import sync success", { domain, nonUniqueId });
        successList.push({ hostname, nonUniqueId });
      } else {
        warn("Import sync failed", { domain, nonUniqueId });
        serverFailList.push({ hostname, nonUniqueId });
      }
    } else {
      // No access code — save locally only
      successList.push({ hostname, nonUniqueId });
    }
  }

  await setStorage({ sessions: currentSessions });
  log("Import finished", {
    imported: successList.length,
    skipped: expiredList.length,
    syncFailed: serverFailList.length,
  });
  renderSessions(currentSessions);

  // --- Build summary ---
  const lines = ["Import complete."];

  if (successList.length > 0) {
    const n = successList.length;
    lines.push(`✅ ${n} session${n !== 1 ? "s" : ""} imported successfully.`);
  }

  for (const s of expiredList) {
    lines.push(
      `⚠️ Skipped (expired or invalid): ${s.hostname} (user ${s.nonUniqueId})`,
    );
  }

  for (const s of serverFailList) {
    lines.push(
      `⚠️ Saved locally, sync failed: ${s.hostname} (user ${s.nonUniqueId})`,
    );
  }

  if (!secret && currentSessions && Object.keys(currentSessions).length > 0) {
    lines.push(
      "ℹ️ No access code set — sessions saved locally only, not synced to server.",
    );
  }

  showImportSummary(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Initialise popup
// ---------------------------------------------------------------------------
async function init() {
  const { secret, sessions = {} } = await getStorage(["secret", "sessions"]);
  log("Popup init", {
    hasSecret: Boolean(secret),
    sessions: Object.keys(sessions).length,
  });

  if (secret) {
    document.getElementById("secretInput").value = secret;
  }

  renderSessions(sessions);

  document
    .getElementById("saveSecretBtn")
    .addEventListener("click", async () => {
      const value = document.getElementById("secretInput").value.trim();
      await setStorage({ secret: value });
      log("Secret saved", { hasSecret: Boolean(value), length: value.length });
      showSecretStatus(value ? "Saved!" : "Cleared.");
    });

  document.getElementById("exportBtn").addEventListener("click", handleExport);

  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });

  document
    .getElementById("importFile")
    .addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleImport(file);
      e.target.value = ""; // Reset so the same file can be re-imported
    });
}

document.addEventListener("DOMContentLoaded", init);
