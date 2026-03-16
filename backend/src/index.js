import "dotenv/config";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import crypto from "node:crypto";

const app = express();
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

app.use(express.json());

const PORT = process.env.PORT ?? 3000;
const KEEPALIVE_SECRET = process.env.KEEPALIVE_SECRET;

/**
 * Constant-time secret comparison to prevent timing attacks.
 * Pads both buffers to the same length before calling timingSafeEqual so that
 * a length mismatch cannot be detected via timing.
 */
function validateSecret(provided) {
  if (!KEEPALIVE_SECRET || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(KEEPALIVE_SECRET);
  const len = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  a.copy(paddedA);
  b.copy(paddedB);
  const equal = crypto.timingSafeEqual(paddedA, paddedB);
  return equal && a.length === b.length;
}

// ---------------------------------------------------------------------------
// GET /ping?secret=<KEEPALIVE_SECRET>
// Hit by an external cron job to keep all stored sessions alive.
// ---------------------------------------------------------------------------
app.get("/ping", async (req, res) => {
  if (!validateSecret(req.query.secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const sessions = await prisma.moodleSession.findMany();

  const results = await Promise.all(
    sessions.map(async (session) => {
      try {
        const response = await fetch(`${session.domain}/my/`, {
          headers: { Cookie: session.cookieString },
          redirect: "follow",
        });

        // Failure = redirected to a login page or non-200 status
        const isFailure =
          response.url.includes("/login") || response.status !== 200;

        if (isFailure) {
          const newFailCount = session.failCount + 1;
          if (newFailCount >= 2) {
            await prisma.moodleSession.delete({ where: { id: session.id } });
            await prisma.expiredNotification.create({
              data: { uniqueIdentity: session.uniqueIdentity },
            });
            return { failed: true, deleted: session.uniqueIdentity };
          } else {
            await prisma.moodleSession.update({
              where: { id: session.id },
              data: { failCount: newFailCount },
            });
            return { failed: true, deleted: null };
          }
        } else {
          // Success — reset failCount (updatedAt is auto-managed by @updatedAt)
          await prisma.moodleSession.update({
            where: { id: session.id },
            data: { failCount: 0 },
          });
          return { failed: false, deleted: null };
        }
      } catch {
        // Network-level or DB failure — treat as failure, best-effort DB update
        try {
          const newFailCount = session.failCount + 1;
          if (newFailCount >= 2) {
            await prisma.moodleSession.delete({ where: { id: session.id } });
            await prisma.expiredNotification.create({
              data: { uniqueIdentity: session.uniqueIdentity },
            });
            return { failed: true, deleted: session.uniqueIdentity };
          } else {
            await prisma.moodleSession.update({
              where: { id: session.id },
              data: { failCount: newFailCount },
            });
          }
        } catch {
          // DB error for this session — skip
        }
        return { failed: true, deleted: null };
      }
    }),
  );

  const failed = results.filter((r) => r.failed).length;
  const deleted = results.map((r) => r.deleted).filter(Boolean);

  res.json({ pinged: sessions.length, failed, deleted });
});

// ---------------------------------------------------------------------------
// POST /session
// Called by the extension to register or refresh a session.
// ---------------------------------------------------------------------------
app.post("/session", async (req, res) => {
  const { secret, uniqueIdentity, nonUniqueId, domain, cookieString } =
    req.body ?? {};

  if (!validateSecret(secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!uniqueIdentity || !nonUniqueId || !domain || !cookieString) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  await prisma.moodleSession.upsert({
    where: { uniqueIdentity },
    create: { uniqueIdentity, nonUniqueId, domain, cookieString },
    update: { cookieString, failCount: 0 },
  });

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// DELETE /session
// Called by the extension when a session is detected as locally expired.
// ---------------------------------------------------------------------------
app.delete("/session", async (req, res) => {
  const { secret, uniqueIdentity } = req.body ?? {};

  if (!validateSecret(secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!uniqueIdentity) {
    return res.status(400).json({ error: "Missing uniqueIdentity" });
  }

  try {
    await prisma.moodleSession.delete({ where: { uniqueIdentity } });
  } catch {
    // Row not found — treat as success
  }

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /notifications?secret=<KEEPALIVE_SECRET>&since=<ISO_TIMESTAMP>
// Polled by the extension to discover sessions deleted server-side.
// Also purges ExpiredNotification entries older than 1 hour on each call.
// ---------------------------------------------------------------------------
app.get("/notifications", async (req, res) => {
  if (!validateSecret(req.query.secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const sinceParam = req.query.since;
  const since = sinceParam ? new Date(sinceParam) : new Date(0);

  if (isNaN(since.getTime())) {
    return res.status(400).json({ error: "Invalid since parameter" });
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Run query and cleanup in parallel — they target non-overlapping time ranges
  const [notifications] = await Promise.all([
    prisma.expiredNotification.findMany({
      where: { expiredAt: { gt: since } },
    }),
    prisma.expiredNotification.deleteMany({
      where: { expiredAt: { lt: oneHourAgo } },
    }),
  ]);

  res.json({ expired: notifications.map((n) => n.uniqueIdentity) });
});

app.listen(PORT, () => {
  console.log(`Moodle Keep-Alive backend running on port ${PORT}`);
});
