// background.js — MV3 Service Worker
// Resolve backend URL from remote repo config so it can be changed centrally.
const BACKEND_CONFIG_URL =
  "https://raw.githubusercontent.com/dikie001/moodle-keepalive/main/backend-url.json";
const DEFAULT_BACKEND_URL = "https://api.yourdomain.com";
const BACKEND_URL_TTL_MS = 5 * 60 * 1000;

const LOG_PREFIX = "[Moodle Keep-Alive][background]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

function getAllCookies(filter) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(filter, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(cookies ?? []);
      }
    });
  });
}

function removeCookie(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.remove(details, (removed) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(removed);
      }
    });
  });
}

function setCookie(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.set(details, (cookie) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(cookie);
      }
    });
  });
}

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

  if (type === "CONTENT_LOG") {
    const logger = payload?.level === "warn" ? console.warn : console.log;
    logger(
      "[Moodle Keep-Alive][content->background]",
      ...(payload?.args ?? []),
      {
        href: payload?.href,
      },
    );
    return { ok: true };
  }

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
    const { domain, cookieString, secret } = payload;
    try {
      const backendUrl = await getBackendUrl();
      log("VALIDATE_COOKIE -> backend", {
        backendUrl,
        domain,
        cookieLength: cookieString?.length ?? 0,
        hasSecret: Boolean(secret),
      });

      const response = await fetch(`${backendUrl}/validate-cookie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, domain, cookieString }),
      });

      if (!response.ok) {
        warn("VALIDATE_COOKIE backend returned non-ok", {
          status: response.status,
          domain,
        });
        return { valid: false, status: response.status };
      }

      const data = await response.json();
      log("VALIDATE_COOKIE response", {
        status: data.status,
        finalUrl: data.finalUrl,
        valid: data.valid,
      });

      return {
        valid: data.valid === true,
        status: data.status,
        finalUrl: data.finalUrl,
      };
    } catch (err) {
      warn("VALIDATE_COOKIE failed for domain", {
        domain,
        error: err?.message ?? String(err),
      });
      return { valid: false };
    }
  }

  if (type === "IMPORT_COOKIES") {
    const { domain, cookieString } = payload;

    if (!domain || !cookieString) {
      warn("IMPORT_COOKIES: missing domain or cookieString", { domain });
      return { ok: false, error: "Missing domain or cookieString" };
    }

    try {
      // Normalize escaped domains (e.g., "https:\/\/example.com" -> "https://example.com")
      const normalizedDomain = domain.replace(/\\\//g, "/");

      // Extract hostname from URL
      let hostname;
      try {
        hostname = new URL(normalizedDomain).hostname;
      } catch (err) {
        warn("IMPORT_COOKIES: Failed to parse domain URL", {
          domain: normalizedDomain,
          error: err?.message,
        });
        return { ok: false, error: "Invalid domain URL" };
      }

      // Parse cookies from header format and keep the last value for duplicate names.
      const cookies = cookieString.split(";");
      const latestByName = new Map();

      for (const cookie of cookies) {
        const trimmed = cookie.trim();
        if (!trimmed) continue;

        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) {
          log("IMPORT_COOKIES: skipping malformed cookie", { cookie: trimmed });
          continue;
        }

        const name = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();

        if (!name) continue;

        latestByName.set(name, value);
      }

      let removedCookieCount = 0;
      let removedAttemptCount = 0;

      for (const [name] of latestByName) {
        let existingCookies = [];
        try {
          existingCookies = await getAllCookies({ domain: hostname, name });
        } catch (err) {
          warn("IMPORT_COOKIES: Failed to query existing cookies", {
            name,
            error: err?.message ?? String(err),
          });
          continue;
        }

        for (const existing of existingCookies) {
          removedAttemptCount += 1;
          const cookieHost = (existing.domain ?? "").replace(/^\./, "");
          const cookiePath = existing.path || "/";
          const scheme = existing.secure ? "https" : "http";
          const url = `${scheme}://${cookieHost}${cookiePath}`;

          try {
            const removed = await removeCookie({
              url,
              name: existing.name,
              storeId: existing.storeId,
            });
            if (removed) {
              removedCookieCount += 1;
            }
          } catch (err) {
            warn("IMPORT_COOKIES: Failed to remove existing cookie", {
              name,
              domain: existing.domain,
              path: existing.path,
              error: err?.message ?? String(err),
            });
          }
        }
      }

      let setCookieCount = 0;

      for (const [name, value] of latestByName) {

        try {
          await setCookie({
            url: normalizedDomain,
            name,
            value,
            domain: hostname,
            path: "/",
            secure: normalizedDomain.startsWith("https:"),
          });
          setCookieCount += 1;

          log("IMPORT_COOKIES: set cookie", {
            name,
            domain: hostname,
            secure: normalizedDomain.startsWith("https:"),
          });
        } catch (err) {
          warn("IMPORT_COOKIES: Failed to set cookie", {
            name,
            error: err?.message ?? String(err),
          });
        }
      }

      log("IMPORT_COOKIES completed", {
        domain: normalizedDomain,
        hostname,
        uniqueCookieNames: latestByName.size,
        cookiesSet: setCookieCount,
        cookiesRemoved: removedCookieCount,
        cookiesRemoveAttempts: removedAttemptCount,
        totalCookies: cookies.length,
      });

      return {
        ok: true,
        uniqueCookieNames: latestByName.size,
        cookiesSet: setCookieCount,
        cookiesRemoved: removedCookieCount,
      };
    } catch (err) {
      warn("IMPORT_COOKIES: Unexpected error", {
        domain,
        error: err?.message ?? String(err),
      });
      return { ok: false, error: "Failed to import cookies" };
    }
  }

  return { error: "Unknown message type" };
}
