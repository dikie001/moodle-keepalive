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

function showSecretStatus(msg, isError = false, isLoading = false) {
  const el = document.getElementById("secretStatus");
  el.textContent = msg;
  el.className =
    "status-msg" + (isError ? " error" : "") + (isLoading ? " loading" : "");
  clearTimeout(el._timer);
  if (isLoading) {
    return;
  }
  el._timer = setTimeout(() => {
    el.textContent = "";
  }, 2500);
}

function showImportSummary(text) {
  const el = document.getElementById("importSummary");
  el.textContent = text;
  el.style.display = "block";
}

function setSecretWarning(hasSecret) {
  const el = document.getElementById("secretWarning");
  if (hasSecret) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }

  el.textContent =
    "Access code is missing. Cookie validation and server sync are disabled until you save it.";
  el.style.display = "block";
}

function clearImportLog() {
  const el = document.getElementById("importLog");
  el.textContent = "";
  el.style.display = "none";
}

function appendImportLog(line) {
  const el = document.getElementById("importLog");
  const timestamp = new Date().toLocaleTimeString();
  const nextLine = `[${timestamp}] ${line}`;
  el.textContent = el.textContent
    ? `${el.textContent}\n${nextLine}`
    : nextLine;
  el.style.display = "block";
  el.scrollTop = el.scrollHeight;
}

function setImportLoading(isLoading, text = "") {
  const loadingRow = document.getElementById("importLoadingRow");
  const loadingText = document.getElementById("importLoadingText");
  const saveSecretBtn = document.getElementById("saveSecretBtn");
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");

  loadingRow.style.display = isLoading ? "flex" : "none";
  loadingText.textContent = text || "Importing sessions...";

  saveSecretBtn.disabled = isLoading;
  exportBtn.disabled = isLoading;
  importBtn.disabled = isLoading;
}

function syncSecretVisibilityButton(input, button) {
  const isVisible = input.type === "text";
  button.textContent = isVisible ? "🙈" : "👁";
  button.setAttribute("aria-pressed", isVisible ? "true" : "false");
  button.title = isVisible ? "Hide access code" : "Show access code";
  button.setAttribute(
    "aria-label",
    isVisible ? "Hide access code" : "Show access code",
  );
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
  try {
    log("Import started", { filename: file?.name, size: file?.size });
    const summaryEl = document.getElementById("importSummary");
    summaryEl.style.display = "none";
    summaryEl.textContent = "";
    clearImportLog();
    setImportLoading(true, "Reading import file...");
    appendImportLog(`Starting import from ${file?.name || "selected file"}.`);

  // --- Parse ---
  let text;
  try {
    text = await file.text();
  } catch {
    setImportLoading(false);
    appendImportLog("Failed to read file.");
    showImportSummary("Failed to read file.");
    return;
  }

  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    setImportLoading(false);
    appendImportLog("Import aborted: invalid JSON.");
    showImportSummary("Invalid file format. Import aborted.");
    return;
  }

  if (!Array.isArray(entries)) {
    setImportLoading(false);
    appendImportLog("Import aborted: top-level JSON is not an array.");
    showImportSummary("Invalid file format. Import aborted.");
    return;
  }

  if (entries.length === 0) {
    setImportLoading(false);
    appendImportLog("No sessions found in selected file.");
    showImportSummary("No sessions found in file.");
    return;
  }

  appendImportLog(`Parsed file successfully (${entries.length} entries).`);

  // Validate all entries have required fields before processing any
  const required = ["domain", "uniqueIdentity", "cookieString", "nonUniqueId"];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      setImportLoading(false);
      appendImportLog("Import aborted: encountered non-object entry.");
      showImportSummary("Invalid file format. Import aborted.");
      return;
    }
    for (const field of required) {
      if (!entry[field]) {
        setImportLoading(false);
        appendImportLog(`Import aborted: missing required field (${field}).`);
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
  appendImportLog(
    `Storage ready. Existing sessions: ${Object.keys(currentSessions).length}.`,
  );

  if (!secret) {
    appendImportLog("Import blocked: access code is not set.");
    showImportSummary(
      "Import blocked: set Access Code first so cookies can be validated.",
    );
    return;
  }

  setImportLoading(true, "Validating sessions...");

  const successList = [];
  const expiredList = [];
  const serverFailList = [];

  // --- Validate & upsert each entry ---
  for (const entry of entries) {
    const { domain, uniqueIdentity, cookieString, nonUniqueId } = entry;
    const hostname = getHostname(domain);
    appendImportLog(`Validating ${hostname} (user ${nonUniqueId})...`);

    // Live cookie validation via background worker
    let valid = false;
    let skipReason = null;
    let skipDetails = null;
    try {
      const result = await sendMessage({
        type: "VALIDATE_COOKIE",
        payload: { domain, cookieString, secret },
      });
      valid = result?.valid === true;
      log("Import validation result", {
        domain,
        nonUniqueId,
        valid,
        status: result?.status,
        finalUrl: result?.finalUrl,
        error: result?.error,
      });
      if (valid) {
        appendImportLog(
          `Validation passed for ${hostname} (user ${nonUniqueId}).`,
        );
      } else {
        const status = result?.status;
        if (status === 403) {
          skipReason = "secret_invalid";
          skipDetails = "Access code is incorrect";
          appendImportLog(
            `Validation failed for ${hostname} (user ${nonUniqueId}): access code rejected.`,
          );
        } else if (status === 400) {
          skipReason = "request_malformed";
          skipDetails = "Validation request was malformed";
          appendImportLog(
            `Validation failed for ${hostname} (user ${nonUniqueId}): request error.`,
          );
        } else if (status && status >= 500) {
          skipReason = "backend_error";
          skipDetails = `Backend error (HTTP ${status})`;
          appendImportLog(
            `Validation failed for ${hostname} (user ${nonUniqueId}): backend error.`,
          );
        } else if (status) {
          skipReason = "unexpected_status";
          skipDetails = `Unexpected HTTP ${status} from backend`;
          appendImportLog(
            `Validation failed for ${hostname} (user ${nonUniqueId}): HTTP ${status}.`,
          );
        } else {
          skipReason = "session_invalid";
          skipDetails = "Cookie is invalid or expired";
          appendImportLog(
            `Validation failed for ${hostname} (user ${nonUniqueId}): invalid session.`,
          );
        }
      }
    } catch (err) {
      // Network-level error
      skipReason = "network_error";
      skipDetails = "Network or messaging failure";
      warn("Import validation message failed", {
        domain,
        nonUniqueId,
        error: err?.message,
      });
      appendImportLog(
        `Validation request failed for ${hostname} (user ${nonUniqueId}): network error.`,
      );
    }

    if (!valid) {
      warn("Import skipped invalid session", {
        domain,
        nonUniqueId,
        reason: skipReason,
      });
      expiredList.push({
        hostname,
        nonUniqueId,
        reason: skipReason,
        details: skipDetails,
      });
      continue;
    }

    // Upsert session locally (create or replace cookieString)
    currentSessions[uniqueIdentity] = { cookieString, domain, nonUniqueId };
    appendImportLog(`Saved locally: ${hostname} (user ${nonUniqueId}).`);

    // Sync to backend if access code is configured
    let synced = false;
    setImportLoading(true, "Syncing validated sessions...");
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
      appendImportLog(`Synced to server: ${hostname} (user ${nonUniqueId}).`);
      successList.push({ hostname, nonUniqueId });
    } else {
      warn("Import sync failed", { domain, nonUniqueId });
      appendImportLog(
        `Server sync failed: ${hostname} (user ${nonUniqueId}) (saved locally).`,
      );
      serverFailList.push({ hostname, nonUniqueId });
    }
  }

  await setStorage({ sessions: currentSessions });
  log("Import finished", {
    imported: successList.length,
    skipped: expiredList.length,
    syncFailed: serverFailList.length,
  });
  renderSessions(currentSessions);
  setImportLoading(false);

  // --- Build summary ---
  const lines = ["Import complete."];

  if (successList.length > 0) {
    const n = successList.length;
    lines.push(`✅ ${n} session${n !== 1 ? "s" : ""} imported successfully.`);
  }

  for (const s of expiredList) {
    const details = s.details || "Unknown reason";
    lines.push(
      `⚠️ Skipped: ${s.hostname} (user ${s.nonUniqueId}) — ${details}`,
    );
  }

  for (const s of serverFailList) {
    lines.push(
      `⚠️ Saved locally, sync failed: ${s.hostname} (user ${s.nonUniqueId})`,
    );
  }

  appendImportLog(
    `Import finished. Success: ${successList.length}, skipped: ${expiredList.length}, sync failed: ${serverFailList.length}.`,
  );

    showImportSummary(lines.join("\n"));
  } catch (err) {
    warn("Import failed unexpectedly", err?.message ?? String(err));
    appendImportLog("Import failed unexpectedly.");
    showImportSummary("Import failed unexpectedly. Please try again.");
  } finally {
    setImportLoading(false);
  }
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
  setSecretWarning(Boolean(secret));

  renderSessions(sessions);

  // Toggle secret visibility
  const secretInput = document.getElementById("secretInput");
  const toggleSecretVisibilityBtn = document.getElementById(
    "toggleSecretVisibility",
  );
  syncSecretVisibilityButton(secretInput, toggleSecretVisibilityBtn);

  toggleSecretVisibilityBtn.addEventListener("click", () => {
    const isPassword = secretInput.type === "password";
    secretInput.type = isPassword ? "text" : "password";
    syncSecretVisibilityButton(secretInput, toggleSecretVisibilityBtn);
  });

  document
    .getElementById("saveSecretBtn")
    .addEventListener("click", async () => {
      const value = document.getElementById("secretInput").value.trim();

      if (!value) {
        // Clearing the secret
        await setStorage({ secret: "" });
        log("Secret cleared");
        showSecretStatus("Cleared.");
        setSecretWarning(false);
        return;
      }

      // Validate the secret with the backend
      try {
        showSecretStatus("Validating...", false, true);
        const validationResponse = await sendMessage({
          type: "VALIDATE_SECRET_CODE",
          payload: { secret: value },
        });

        if (!validationResponse?.valid) {
          log("Secret validation failed", {
            status: validationResponse?.status,
          });
          showSecretStatus("Invalid access code.", true);
          return;
        }

        // Secret is valid, save it
        await setStorage({ secret: value });
        log("Secret saved and validated", { length: value.length });
        showSecretStatus("Access code verified and saved!");
        setSecretWarning(true);
      } catch (err) {
        warn("Secret validation error", err?.message);
        showSecretStatus(
          "Could not validate access code (network error).",
          true,
        );
      }
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
