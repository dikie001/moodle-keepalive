// content.js — runs at document_idle on every page
(function () {
  "use strict";

  const LOG_PREFIX = "[Moodle Keep-Alive][content]";
  function forwardLog(level, args) {
    try {
      chrome.runtime.sendMessage({
        type: "CONTENT_LOG",
        payload: {
          level,
          args,
          href: window.location.href,
        },
      });
    } catch {
      // Ignore logging transport failures.
    }
  }

  const log = (...args) => {
    console.log(LOG_PREFIX, ...args);
    forwardLog("log", args);
  };
  const warn = (...args) => {
    console.warn(LOG_PREFIX, ...args);
    forwardLog("warn", args);
  };

  log("Content script injected", { href: window.location.href });

  // Step A — Detect Moodle. Exit immediately if this is not a Moodle page.
  if (typeof window.M === "undefined" || !window.M?.cfg?.wwwroot) {
    log("window.M.cfg.wwwroot missing; skipping non-Moodle page");
    return;
  }

  const domain = window.M.cfg.wwwroot;
  log("Moodle page detected", {
    href: window.location.href,
    domain,
  });

  // Step B — Extract the logged-in user id from the page HTML.
  const nonUniqueId =
    document.documentElement.outerHTML.match(/data-userid="(\d+)"/)?.[1] ??
    null;
  log("User ID detection result", { nonUniqueId });

  if (nonUniqueId) {
    // -----------------------------------------------------------------------
    // Step C — User is logged in: register / refresh the session on the backend
    // -----------------------------------------------------------------------
    const uniqueIdentity = `${domain}/user/profile.php?id=${nonUniqueId}`;
    const cookieString = document.cookie;
    log("Attempting session register", {
      uniqueIdentity,
      cookieLength: cookieString.length,
    });

    chrome.storage.local.get(["secret"], ({ secret }) => {
      if (!secret) {
        warn("Secret missing in storage; skipping POST_SESSION");
        return;
      }

      log("Secret found; sending POST_SESSION", { uniqueIdentity });

      chrome.runtime.sendMessage(
        {
          type: "POST_SESSION",
          payload: {
            secret,
            uniqueIdentity,
            nonUniqueId,
            domain,
            cookieString,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            warn(
              "POST_SESSION messaging failed",
              chrome.runtime.lastError.message,
            );
            return;
          }

          log("POST_SESSION response", response);

          if (response?.ok) {
            chrome.storage.local.get(["sessions"], ({ sessions = {} }) => {
              sessions[uniqueIdentity] = { cookieString, domain, nonUniqueId };
              chrome.storage.local.set({ sessions });
              log("Session saved locally", {
                uniqueIdentity,
                totalSessions: Object.keys(sessions).length,
              });
            });
          } else {
            warn("POST_SESSION returned non-ok response", response);
          }
        },
      );
    });
  } else {
    // -----------------------------------------------------------------------
    // Step D — User is NOT logged in: check for the login page and attempt to
    //           restore a previously saved session via cookie injection.
    // -----------------------------------------------------------------------
    const isLoginPage =
      window.location.href.includes("/login/index.php") ||
      window.location.pathname === "/login/";
    log("Logged-out branch", { isLoginPage, href: window.location.href });

    if (!isLoginPage) return;

    chrome.storage.local.get(["sessions"], ({ sessions = {} }) => {
      // Find a stored session for the current Moodle domain
      const matchingEntry = Object.entries(sessions).find(
        ([, s]) => s.domain === domain,
      );

      if (!matchingEntry) {
        log("No saved session found for this domain", { domain });
        return;
      }

      const [sessionKey, session] = matchingEntry;
      const alreadyAttempted = sessionStorage.getItem("reloadAttempted");
      log("Saved session found on login page", {
        sessionKey,
        alreadyAttempted: Boolean(alreadyAttempted),
      });

      if (!alreadyAttempted) {
        // First attempt — inject stored cookies and reload
        sessionStorage.setItem("reloadAttempted", "1");

        // Browsers require one document.cookie assignment per cookie pair
        session.cookieString.split("; ").forEach((pair) => {
          document.cookie = pair;
        });

        log("Cookie injection done; reloading page", {
          cookiePairs: session.cookieString.split("; ").length,
        });

        window.location.reload();
      } else {
        // Reload brought us back to the login page — session is expired
        sessionStorage.removeItem("reloadAttempted");

        chrome.storage.local.get(["secret"], ({ secret }) => {
          if (secret) {
            log("Second login hit; deleting expired session from backend", {
              sessionKey,
            });
            chrome.runtime.sendMessage({
              type: "DELETE_SESSION",
              payload: { secret, uniqueIdentity: sessionKey },
            });
          } else {
            warn("Secret missing while deleting expired session", {
              sessionKey,
            });
          }

          // Remove from local storage
          delete sessions[sessionKey];
          chrome.storage.local.set({ sessions });
          log("Expired session removed locally", {
            sessionKey,
            totalSessions: Object.keys(sessions).length,
          });

          // Show a non-intrusive banner
          const banner = document.createElement("div");
          banner.setAttribute("role", "alert");
          banner.style.cssText = [
            "position:fixed",
            "top:0",
            "left:0",
            "right:0",
            "background:#f8d7da",
            "color:#721c24",
            "padding:12px 16px",
            "text-align:center",
            "font-size:14px",
            "z-index:2147483647",
            "border-bottom:1px solid #f5c6cb",
            "font-family:system-ui,Arial,sans-serif",
          ].join(";");
          banner.textContent =
            "Your saved Moodle session has expired and was removed.";
          document.body?.appendChild(banner);
        });
      }
    });
  }
})();
