// content.js — runs at document_idle on every page
(function () {
  "use strict";

  const LOG_PREFIX = "[Moodle Keep-Alive][content]";
  const PAGE_BRIDGE_MESSAGE_TYPE = "MOODLE_KEEPALIVE_PAGE_CONTEXT";

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

  function extractWwwrootFromHtml() {
    const html = document.documentElement.outerHTML;
    const patterns = [
      /"wwwroot"\s*:\s*"([^"]+)"/,
      /'wwwroot'\s*:\s*'([^']+)'/,
      /M\.cfg\.wwwroot\s*=\s*"([^"]+)"/,
      /M\.cfg\.wwwroot\s*=\s*'([^']+)'/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  function getMoodleWwwrootFromPage() {
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 1000);

      function onMessage(event) {
        if (event.source !== window) return;
        if (event.data?.type !== PAGE_BRIDGE_MESSAGE_TYPE) return;

        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(event.data.wwwroot ?? null);
      }

      window.addEventListener("message", onMessage);

      const script = document.createElement("script");
      script.textContent = `
        window.postMessage({
          type: "${PAGE_BRIDGE_MESSAGE_TYPE}",
          wwwroot: window.M?.cfg?.wwwroot ?? null,
        }, "*");
      `;

      (document.documentElement || document.head || document.body).appendChild(
        script,
      );
      script.remove();
    });
  }

  async function resolveMoodleWwwroot() {
    const pageWwwroot = await getMoodleWwwrootFromPage();
    if (pageWwwroot) {
      log("Resolved wwwroot from page context", { pageWwwroot });
      return pageWwwroot;
    }

    const htmlWwwroot = extractWwwrootFromHtml();
    if (htmlWwwroot) {
      log("Resolved wwwroot from HTML fallback", { htmlWwwroot });
      return htmlWwwroot;
    }

    return null;
  }

  async function main() {
    log("Content script injected", { href: window.location.href });

    // Step A — Detect Moodle. Page globals like window.M live in the page
    // world, so we bridge into that context instead of reading them directly.
    const domain = await resolveMoodleWwwroot();
    if (!domain) {
      log("Could not resolve Moodle wwwroot; skipping non-Moodle page");
      return;
    }

    log("Moodle page detected", {
      href: window.location.href,
      domain,
    });

    function isMoodleLoggedIn() {
      const baseUrl =
        domain ||
        (typeof M !== "undefined" && M.cfg?.wwwroot
          ? M.cfg.wwwroot
          : "https://ielearning.ueab.ac.ke");

      // Method 1: Body class check
      if (document.body?.classList.contains("loggedin")) return true;
      if (document.body?.classList.contains("notloggedin")) return false;

      // Method 2: Logout link contains wwwroot
      const logoutLink = document.querySelector(
        `a[href*="${baseUrl}/login/logout.php"]`,
      );
      if (logoutLink) return true;

      // Method 3: Login link present = not logged in
      const loginLink = document.querySelector(
        `a[href*="${baseUrl}/login/index.php"]`,
      );
      if (loginLink) return false;

      // Method 4: sesskey input (only exists when logged in)
      if (document.querySelector('input[name="sesskey"]')) return true;

      return false;
    }

    const loggedIn = isMoodleLoggedIn();
    log("Login state detection", { loggedIn, href: window.location.href });

    if (loggedIn) {
      // -----------------------------------------------------------------------
      // Step C — User is logged in: register / refresh the session on the backend
      // -----------------------------------------------------------------------
      const nonUniqueId =
        document.documentElement.outerHTML.match(/data-userid="(\d+)"/)?.[1] ??
        null;
      log("User ID detection result", { nonUniqueId });

      if (!nonUniqueId) {
        warn("Logged-in state detected but user ID was not found; skipping");
        return;
      }

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
                sessions[uniqueIdentity] = {
                  cookieString,
                  domain,
                  nonUniqueId,
                };
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
      // Step D — User is NOT logged in: attempt to restore a previously saved
      //           session via cookie injection.
      // -----------------------------------------------------------------------
      log("Logged-out branch", { href: window.location.href });

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
          // First attempt — request background worker to inject stored cookies and reload
          sessionStorage.setItem("reloadAttempted", "1");

          log("Requesting background worker to import cookies and reload");

          chrome.runtime.sendMessage(
            {
              type: "IMPORT_COOKIES",
              payload: {
                domain: session.domain,
                cookieString: session.cookieString,
              },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                warn(
                  "IMPORT_COOKIES messaging failed",
                  chrome.runtime.lastError.message,
                );
                return;
              }

              log("IMPORT_COOKIES response received; reloading page", response);
              window.location.reload();
            },
          );
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
  }

  void main();
})();
