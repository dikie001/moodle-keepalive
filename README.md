# Moodle Keep-Alive

Keeps Moodle user sessions alive server-side via periodic pings, and auto-restores sessions when visiting a Moodle login page.

---

## Project structure

```
moodle-keepalive/
├── backend/          # Node.js + Express + Prisma + PostgreSQL
│   ├── prisma/
│   │   └── schema.prisma
│   ├── src/
│   │   └── index.js
│   ├── .env.example
│   └── package.json
└── extension/        # Chrome Extension (Manifest V3)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.html
    ├── popup.js
    └── icon.png      ← add a 128×128 PNG here (required)
```

---

## Backend setup

### Requirements

- Node.js 18+
- PostgreSQL database

### Steps

```bash
cd backend

# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env: set DATABASE_URL and KEEPALIVE_SECRET

# Push schema to the database
npm run db:generate
npm run db:push          # or: npm run db:migrate (for migration history)

# Start the server
npm start                # production
npm run dev              # development (auto-restart on file change)
```

### Environment variables

| Variable           | Description                                      |
| ------------------ | ------------------------------------------------ |
| `DATABASE_URL`     | PostgreSQL connection string                     |
| `KEEPALIVE_SECRET` | Shared secret used by the cron job and extension |
| `PORT`             | HTTP port (default: `3000`)                      |

---

## External cron job

The backend does **not** self-schedule pings. Configure an external cron job (GitHub Actions, Railway cron, cron-job.org, etc.) to call:

```
GET https://your-backend.com/ping?secret=<KEEPALIVE_SECRET>
```

Recommended interval: every **4 minutes**.

---

## Chrome Extension setup

1. Add a **128×128 PNG** file named `icon.png` inside the `extension/` folder.
2. Open `extension/background.js` and set `BACKEND_URL` to your deployed backend URL:
   ```js
   const BACKEND_URL = "https://your-backend.com";
   ```
3. Open Chrome → `chrome://extensions` → enable **Developer mode**.
4. Click **Load unpacked** → select the `extension/` folder.
5. Click the extension icon → enter your **Access Code** (must match `KEEPALIVE_SECRET`) → Save.

---

## How it works

### Session registration

When you visit any Moodle page while logged in, the content script detects `window.M.cfg.wwwroot` and your `data-userid`, captures `document.cookie`, and POSTs the session to the backend. The session is also stored locally in `chrome.storage.local`.

### Keepalive pings

The external cron job calls `GET /ping`, which fetches `<domain>/my/` for every stored session using its saved cookie. If a session redirects to the login page or returns non-200 twice consecutively, it is deleted and an `ExpiredNotification` is recorded.

### Expiry notifications

The extension polls `GET /notifications` every 5 minutes. If any of its locally tracked sessions appear in the `expired` list, they are removed from local storage and a browser notification is shown.

### Login page restoration

If you visit a Moodle login page and a session for that domain is stored locally:

1. The content script injects the saved cookies and reloads the page.
2. If the reload still lands on the login page (cookies are expired), the session is deleted locally and from the backend, and a banner is displayed.

---

## API reference

| Endpoint                            | Auth          | Description                        |
| ----------------------------------- | ------------- | ---------------------------------- |
| `GET /ping?secret=`                 | query param   | Ping all sessions (called by cron) |
| `POST /session`                     | body `secret` | Register or refresh a session      |
| `DELETE /session`                   | body `secret` | Delete a session                   |
| `GET /notifications?secret=&since=` | query param   | Poll for server-deleted sessions   |

---

## Security notes

- The `KEEPALIVE_SECRET` is compared with a constant-time function (`crypto.timingSafeEqual`) to prevent timing attacks.
- All Prisma queries use parameterised statements — no SQL injection risk.
- The extension stores the access code in `chrome.storage.local` (extension-scoped, not accessible to web pages).
- Cookie injection on the login page is limited to non-HttpOnly cookies accessible via `document.cookie`. HttpOnly session cookies (if set by the Moodle server) will not be injectable this way.
