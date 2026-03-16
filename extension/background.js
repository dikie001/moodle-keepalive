// background.js — MV3 Service Worker
// Resolve backend URL from remote repo config so it can be changed centrally.
const BACKEND_CONFIG_URL =
  "https://raw.githubusercontent.com/dikie001/moodle-keepalive/main/backend-url.json";
const DEFAULT_BACKEND_URL = "https://api.yourdomain.com";
const BACKEND_URL_TTL_MS = 5 * 60 * 1000;

const LOG_PREFIX = "[Moodle Keep-Alive][background]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

let cachedBackendUrl = DEFAULT_BACKEND_URL;
let backendUrlLastFetchedAt = 0;

async function getBackendUrl() {
  const now = Date.now();
  if (now - backendUrlLastFetchedAt < BACKEND_URL_TTL_MS) {
    log("Using cached backend URL", cachedBackendUrl);
    return cachedBackendUrl;
  }

  try {
    log("Fetching remote backend config", BACKEND_CONFIG_URL);
    const response = await fetch(BACKEND_CONFIG_URL, { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      const productionUrl = data?.backendUrl?.production;
      if (typeof productionUrl === "string" && productionUrl.length > 0) {
        cachedBackendUrl = productionUrl.replace(/\/$/, "");
        log("Resolved backend URL from remote config", cachedBackendUrl);
      } else {
        warn(
          "Remote config loaded but production URL missing; using fallback",
          {
            cachedBackendUrl,
          },
        );
      }
    } else {
      warn("Remote config fetch failed", { status: response.status });
    }
  } catch {
    // Keep using the last known URL (or default) when config fetch fails.
    warn("Remote config fetch threw; using fallback", cachedBackendUrl);
  }

  backendUrlLastFetchedAt = now;
  return cachedBackendUrl;
}

// Fallback icon data URL (1×1 transparent PNG) used when icon.png is absent.
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Alarm setup — create/replace on install and browser startup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  log("Extension installed");
  void getBackendUrl();
  chrome.alarms.create("checkNotifications", { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  log("Browser startup detected");
  void getBackendUrl();
  chrome.alarms.create("checkNotifications", { periodInMinutes: 5 });
});

// ---------------------------------------------------------------------------
// Alarm handler — poll backend for server-deleted sessions
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "checkNotifications") return;

  log("checkNotifications alarm fired");

  const {
    secret,
    sessions = {},
    lastNotificationCheck,
  } = await chrome.storage.local.get([
    "secret",
    "sessions",
    "lastNotificationCheck",
  ]);

  if (!secret) {
    log("Skipping notifications poll because secret is not set");
    return;
  }

  const since = lastNotificationCheck || new Date(0).toISOString();

  try {
    const backendUrl = await getBackendUrl();
    log("Polling notifications", { backendUrl, since });
    const response = await fetch(
      `${backendUrl}/notifications?secret=${encodeURIComponent(secret)}&since=${encodeURIComponent(since)}`,
    );
    if (!response.ok) {
      warn("Notifications request returned non-ok", {
        status: response.status,
      });
      return;
    }

    const data = await response.json();
    log("Notifications response", {
      expiredCount: (data.expired ?? []).length,
    });

    for (const uniqueIdentity of data.expired ?? []) {
      if (sessions[uniqueIdentity]) {
        const domain = sessions[uniqueIdentity].domain;
        delete sessions[uniqueIdentity];

        const iconUrl = chrome.runtime.getURL("icon.png") || FALLBACK_ICON;
        chrome.notifications.create(`expired-${Date.now()}`, {
          type: "basic",
          iconUrl,
          title: "Moodle Session Expired",
          message: `Your Moodle session at ${domain} has expired and was removed.`,
        });
      }
    }

    await chrome.storage.local.set({
      sessions,
      lastNotificationCheck: new Date().toISOString(),
    });
  } catch {
    // Network error — will retry on next alarm
    warn("Notifications poll failed; will retry on next alarm");
  }
});

// ---------------------------------------------------------------------------
// Message handler — proxies all network requests from content script & popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log("Message received", { type: message?.type });
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      warn("Message handling failed", error?.message ?? error);
      sendResponse({ error: "Request failed" });
    });
  return true; // Keep message channel open for async response
});

async function handleMessage(message) {
  const { type, payload } = message;

  if (type === "POST_SESSION") {
    const backendUrl = await getBackendUrl();
    log("POST_SESSION -> backend", {
      backendUrl,
      uniqueIdentity: payload?.uniqueIdentity,
    });
    const response = await fetch(`${backendUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    log("POST_SESSION response", { status: response.status, ok: response.ok });
    return { ok: response.ok, status: response.status };
  }

  if (type === "DELETE_SESSION") {
    const backendUrl = await getBackendUrl();
    log("DELETE_SESSION -> backend", {
      backendUrl,
      uniqueIdentity: payload?.uniqueIdentity,
    });
    const response = await fetch(`${backendUrl}/session`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    log("DELETE_SESSION response", {
      status: response.status,
      ok: response.ok,
    });
    return { ok: response.ok, status: response.status };
  }

  if (type === "VALIDATE_COOKIE") {
    const { domain, cookieString } = payload;
    try {
      log("VALIDATE_COOKIE -> domain", {
        domain,
        cookieLength: cookieString?.length ?? 0,
      });
      const response = await fetch(`${domain}/my/`, {
        headers: { Cookie: cookieString },
        redirect: "follow",
      });
      const valid = !response.url.includes("/login") && response.status === 200;
      log("VALIDATE_COOKIE response", {
        status: response.status,
        finalUrl: response.url,
        valid,
      });
      return { valid };
    } catch {
      warn("VALIDATE_COOKIE failed for domain", domain);
      return { valid: false };
    }
  }

  return { error: "Unknown message type" };
}
