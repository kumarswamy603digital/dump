/* ============================================================
   Dump — local development server
   Serves the static frontend and delegates /api/* to the SAME
   shared handler used by the Vercel serverless functions
   (../lib/handler.js), so there is one source of truth.

   Storage: libSQL. By default it uses a local SQLite file
   (server/data/dump.db) so this runs fully offline. Point
   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN at a hosted Turso DB to
   share the exact same data as the deployed app.

   Run:  npm start   (→ node server/server.js)
   ============================================================ */

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");   // static frontend root
const DATA_DIR = path.join(__dirname, "data");
const PORT = process.env.PORT || 4000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- .env loader (dependency-free) — MUST run first ---------------- */
(function loadEnv() {
  for (const f of [path.join(ROOT, ".env"), path.join(__dirname, ".env")]) {
    let txt;
    try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
})();

/* ---------------- Persist a JWT secret locally (dev convenience) ----------------
   On Vercel the secret comes from DUMP_JWT_SECRET. Locally, if it's not set we
   persist a random one to server/data/.secret so logins survive restarts.
   This MUST happen before requiring the handler (it reads the env at load). */
if (!process.env.DUMP_JWT_SECRET) {
  const f = path.join(DATA_DIR, ".secret");
  try {
    process.env.DUMP_JWT_SECRET = fs.readFileSync(f, "utf8");
  } catch {
    const s = crypto.randomBytes(48).toString("hex");
    try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
    process.env.DUMP_JWT_SECRET = s;
  }
}

// Default the DB to a local file unless a Turso URL is configured.
if (!process.env.TURSO_DATABASE_URL) {
  process.env.TURSO_DATABASE_URL = "file:" + path.join(DATA_DIR, "dump.db");
}

const { handleApi, ready } = require("../lib/handler");

/* ---------------- Static file serving ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  // never serve the server dir, the shared lib, or api sources
  if (filePath.startsWith(path.join(ROOT, "server")) ||
      filePath.startsWith(path.join(ROOT, "lib")) ||
      filePath.startsWith(path.join(ROOT, "api"))) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Bad request" }));
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await ready();
      return await handleApi(req, res, url);
    } catch (e) {
      if (!res.headersSent) {
        const status = e.message === "Payload too large" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: e.message || "Server error" }));
      }
    }
  } else {
    return serveStatic(req, res, url.pathname);
  }
});

// Warm the schema, then listen.
ready().then(() => {
  server.listen(PORT, () => {
    console.log(`Dump server running at http://localhost:${PORT}`);
    console.log(`  Database:          ${process.env.TURSO_DATABASE_URL}`);
    console.log(`  AI classification: ${process.env.GROQ_API_KEY ? "Groq" : "rule-based (no GROQ_API_KEY)"}`);
    console.log(`  Screenshot OCR:    ${process.env.OCR_API_KEY ? "OCR.space (key detected)" : (process.env.GROQ_API_KEY ? "Groq vision fallback" : "disabled (set OCR_API_KEY)")}`);
  });
}).catch((e) => {
  console.error("Failed to initialize database:", e);
  process.exit(1);
});
