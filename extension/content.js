// content.js — runs at document_idle on every page
(function () {
  "use strict";

  // Step A — Detect Moodle. Exit immediately if this is not a Moodle page.
  if (typeof window.M === "undefined" || !window.M?.cfg?.wwwroot) return;

  const domain = window.M.cfg.wwwroot;

  // Step B — Extract the logged-in user id from the page HTML.
  const nonUniqueId =
    document.documentElement.outerHTML.match(/data-userid="(\d+)"/)?.[1] ??
    null;

  if (nonUniqueId) {
    // -----------------------------------------------------------------------
    // Step C — User is logged in: register / refresh the session on the backend
    // -----------------------------------------------------------------------
    const uniqueIdentity = `${domain}/user/profile.php?id=${nonUniqueId}`;
    const cookieString = document.cookie;

    chrome.storage.local.get(["secret"], ({ secret }) => {
      if (!secret) return; // Access code not configured — do nothing silently

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
          if (chrome.runtime.lastError) return; // Service worker unavailable
          if (response?.ok) {
            chrome.storage.local.get(["sessions"], ({ sessions = {} }) => {
              sessions[uniqueIdentity] = { cookieString, domain, nonUniqueId };
              chrome.storage.local.set({ sessions });
            });
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

    if (!isLoginPage) return;

    chrome.storage.local.get(["sessions"], ({ sessions = {} }) => {
      // Find a stored session for the current Moodle domain
      const matchingEntry = Object.entries(sessions).find(
        ([, s]) => s.domain === domain,
      );

      if (!matchingEntry) return;

      const [sessionKey, session] = matchingEntry;
      const alreadyAttempted = sessionStorage.getItem("reloadAttempted");

      if (!alreadyAttempted) {
        // First attempt — inject stored cookies and reload
        sessionStorage.setItem("reloadAttempted", "1");

        // Browsers require one document.cookie assignment per cookie pair
        session.cookieString.split("; ").forEach((pair) => {
          document.cookie = pair;
        });

        window.location.reload();
      } else {
        // Reload brought us back to the login page — session is expired
        sessionStorage.removeItem("reloadAttempted");

        chrome.storage.local.get(["secret"], ({ secret }) => {
          if (secret) {
            chrome.runtime.sendMessage({
              type: "DELETE_SESSION",
              payload: { secret, uniqueIdentity: sessionKey },
            });
          }

          // Remove from local storage
          delete sessions[sessionKey];
          chrome.storage.local.set({ sessions });

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
