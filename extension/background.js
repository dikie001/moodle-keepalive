// background.js — MV3 Service Worker
// Update BACKEND_URL to point to your deployed backend.
const BACKEND_URL = "https://your-backend.com";

// Fallback icon data URL (1×1 transparent PNG) used when icon.png is absent.
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Alarm setup — create/replace on install and browser startup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("checkNotifications", { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("checkNotifications", { periodInMinutes: 5 });
});

// ---------------------------------------------------------------------------
// Alarm handler — poll backend for server-deleted sessions
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "checkNotifications") return;

  const {
    secret,
    sessions = {},
    lastNotificationCheck,
  } = await chrome.storage.local.get([
    "secret",
    "sessions",
    "lastNotificationCheck",
  ]);

  if (!secret) return;

  const since = lastNotificationCheck || new Date(0).toISOString();

  try {
    const response = await fetch(
      `${BACKEND_URL}/notifications?secret=${encodeURIComponent(secret)}&since=${encodeURIComponent(since)}`,
    );
    if (!response.ok) return;

    const data = await response.json();

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
  }
});

// ---------------------------------------------------------------------------
// Message handler — proxies all network requests from content script & popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse({ error: "Request failed" }));
  return true; // Keep message channel open for async response
});

async function handleMessage(message) {
  const { type, payload } = message;

  if (type === "POST_SESSION") {
    const response = await fetch(`${BACKEND_URL}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status };
  }

  if (type === "DELETE_SESSION") {
    const response = await fetch(`${BACKEND_URL}/session`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status };
  }

  if (type === "VALIDATE_COOKIE") {
    const { domain, cookieString } = payload;
    try {
      const response = await fetch(`${domain}/my/`, {
        headers: { Cookie: cookieString },
        redirect: "follow",
      });
      const valid = !response.url.includes("/login") && response.status === 200;
      return { valid };
    } catch {
      return { valid: false };
    }
  }

  return { error: "Unknown message type" };
}
