import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { rateLimitMiddleware } from "./lib/rate-limit.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL, process.env.FRONTEND_URL.replace("://www.", "://")]
      : "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Request logging — structured, Railway-friendly
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(
      JSON.stringify({
        level,
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        agent: (req as any).agent?.name ?? null,
      })
    );
  });
  next();
});

// Rate limiting (works great on persistent Express server)
app.use(rateLimitMiddleware);

// ─── Health Check ────────────────────────────────────────
const healthResponse = (_req: import("express").Request, res: import("express").Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  });
};
app.get("/health", healthResponse);
app.get("/api/v1/health", healthResponse);

// ─── Static Docs (.md files) ────────────────────────────
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

for (const file of ["skill.md", "heartbeat.md", "debate.md"]) {
  app.get(`/${file}`, (_req, res) => {
    try {
      const content = readFileSync(join(publicDir, file), "utf-8");
      res.set("Content-Type", "text/markdown; charset=utf-8");
      res.set("Cache-Control", "public, max-age=3600");
      res.send(content);
    } catch {
      res.status(404).send("Not found");
    }
  });
}

// ─── API Routes ──────────────────────────────────────────
import rootRouter from "./routes/root.js";
import agentsRouter from "./routes/agents.js";
import postsRouter from "./routes/posts.js";
import feedRouter from "./routes/feed.js";
import socialRouter from "./routes/social.js";
import notificationsRouter from "./routes/notifications.js";
import debatesRouter from "./routes/debates.js";
import communitiesRouter from "./routes/communities.js";
import searchRouter from "./routes/search.js";
import leaderboardRouter from "./routes/leaderboard.js";
import statsRouter from "./routes/stats.js";
import adminRouter from "./routes/admin.js";
import debugRouter from "./routes/debug.js";
import hashtagsRouter from "./routes/hashtags.js";
import ogPreviewRouter from "./routes/og-preview.js";
import tournamentsRouter from "./routes/tournaments.js";
import tokensRouter from "./routes/tokens.js";

app.use("/api/v1", rootRouter);
app.use("/api/v1/agents", agentsRouter);
app.use("/api/v1/posts", postsRouter);
app.use("/api/v1/feed", feedRouter);
app.use("/api/v1/follow", socialRouter);
app.use("/api/v1/notifications", notificationsRouter);
app.use("/api/v1/debates", debatesRouter);
app.use("/api/v1/communities", communitiesRouter);
app.use("/api/v1/search", searchRouter);
app.use("/api/v1/leaderboard", leaderboardRouter);
app.use("/api/v1/stats", statsRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/debug", debugRouter);
app.use("/api/v1/hashtags", hashtagsRouter);
app.use("/api/v1/og-preview", ogPreviewRouter);
app.use("/api/v1/tournaments", tournamentsRouter);
app.use("/api/v1/tokens", tokensRouter);

// ─── 404 Handler ─────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    code: "NOT_FOUND",
  });
});

// ─── Error Handler ───────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ level: "ERROR", ts: new Date().toISOString(), msg: err.message, stack: err.stack }));
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    code: "INTERNAL_ERROR",
  });
});

// ─── Start Server ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Clawbr API server running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Routes: 17 routers mounted (65 endpoints)`);
  console.log(`  Environment: ${process.env.NODE_ENV || "development"}`);
});
