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

  async function resolveMoodleWwwroot() {
    const htmlWwwroot = extractWwwrootFromHtml();
    if (htmlWwwroot) {
      log("Resolved wwwroot from HTML", { htmlWwwroot });
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

    function isMoodleLoginPage() {
      const loginForm = document.querySelector(
        'form[action*="/login/index.php"], form#login',
      );
      const hasCredentialsInputs =
        Boolean(document.querySelector('input[name="username"], #username')) &&
        Boolean(document.querySelector('input[name="password"], #password'));
      const loginAnchor = document.querySelector(
        `a[href*="${domain}/login/index.php"]`,
      );

      return Boolean(loginForm || hasCredentialsInputs || loginAnchor);
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
      const onLoginPage = isMoodleLoginPage();
      log("Logged-out branch", {
        href: window.location.href,
        onLoginPage,
      });

      if (!onLoginPage) {
        log("Not on Moodle login page; skipping restore flow");
        return;
      }

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
          sessionStorage.setItem("reloadAttemptedSessionKey", sessionKey);
          sessionStorage.setItem("reloadAttemptedAt", String(Date.now()));

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

              const importSucceeded =
                response?.ok === true && (response?.cookiesSet ?? 0) > 0;

              if (!importSucceeded) {
                warn("IMPORT_COOKIES did not succeed; skipping reload", {
                  sessionKey,
                  response,
                });
                sessionStorage.removeItem("reloadAttempted");
                sessionStorage.removeItem("reloadAttemptedSessionKey");
                sessionStorage.removeItem("reloadAttemptedAt");
                return;
              }

              log("IMPORT_COOKIES successful; reloading page", {
                sessionKey,
                response,
              });
              window.location.reload();
            },
          );
        } else {
          // Reload brought us back to the login page — session is expired
          const attemptedSessionKey = sessionStorage.getItem(
            "reloadAttemptedSessionKey",
          );
          const attemptedAtRaw = sessionStorage.getItem("reloadAttemptedAt");
          const attemptedAt = Number(attemptedAtRaw || 0);
          const attemptAgeMs = attemptedAt ? Date.now() - attemptedAt : Infinity;
          const isSameSession = attemptedSessionKey === sessionKey;
          const isFreshAttempt = attemptAgeMs >= 0 && attemptAgeMs <= 2 * 60 * 1000;

          sessionStorage.removeItem("reloadAttempted");
          sessionStorage.removeItem("reloadAttemptedSessionKey");
          sessionStorage.removeItem("reloadAttemptedAt");

          if (!isSameSession || !isFreshAttempt) {
            warn("Ignoring stale or mismatched reload attempt; skipping delete", {
              sessionKey,
              attemptedSessionKey,
              attemptAgeMs,
            });
            return;
          }

          chrome.storage.local.get(["secret"], ({ secret }) => {
            if (!secret) {
              warn("Secret missing while deleting expired session", {
                sessionKey,
              });
              return;
            }

            // Require backend validation (which validates against Moodle) before
            // treating a session as expired and removing it.
            chrome.runtime.sendMessage(
              {
                type: "VALIDATE_COOKIE",
                payload: {
                  secret,
                  domain: session.domain,
                  cookieString: session.cookieString,
                },
              },
              (validationResponse) => {
                if (chrome.runtime.lastError) {
                  warn(
                    "VALIDATE_COOKIE messaging failed; skipping delete",
                    chrome.runtime.lastError.message,
                  );
                  return;
                }

                const isValidatedByBackend =
                  validationResponse && typeof validationResponse === "object";

                // Only a successful Moodle check counts (status 200 with valid field set)
                const isSuccessfulMoodleCheck =
                  validationResponse?.status === 200 &&
                  typeof validationResponse?.valid === "boolean";
                const finalUrl = validationResponse?.finalUrl;
                const isStillValid = validationResponse?.valid === true;

                if (!isValidatedByBackend) {
                  warn(
                    "Session expiry validation response malformed; skipping delete",
                    { sessionKey, validationResponse },
                  );
                  return;
                }

                if (!isSuccessfulMoodleCheck) {
                  const status = validationResponse?.status;
                  if (status === 403) {
                    warn(
                      "Access code is invalid; cannot validate session; skipping delete",
                      {
                        sessionKey,
                      },
                    );
                  } else if (status && status >= 500) {
                    warn(
                      `Backend error (HTTP ${status}) during validation; skipping delete`,
                      { sessionKey },
                    );
                  } else if (status === 400) {
                    warn(
                      "Validation request malformed (missing fields); skipping delete",
                      { sessionKey },
                    );
                  } else {
                    warn(
                      `Unexpected validation status ${status}; skipping delete to be safe`,
                      { sessionKey },
                    );
                  }
                  return;
                }

                if (isStillValid) {
                  log("Session validated as still active by Moodle", {
                    sessionKey,
                    finalUrl,
                  });
                  return;
                }

                log(
                  "Moodle + backend confirmed session expired; deleting from backend and local storage",
                  { sessionKey, finalUrl },
                );

                chrome.runtime.sendMessage({
                  type: "DELETE_SESSION",
                  payload: { secret, uniqueIdentity: sessionKey },
                });

                // Remove from local storage only after Moodle + backend confirm invalid.
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
              },
            );
          });
        }
      });
    }
  }

  void main();
})();
