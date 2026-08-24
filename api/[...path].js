/* ============================================================
   Dump — Vercel serverless entry point (catch-all)
   Vercel routes every request under /api/* to this function.
   Static assets (index.html, *.js, *.css, …) are served directly
   from the repo root by Vercel's static hosting.

   All the real logic lives in ../lib/handler.js (shared with the
   local Node server), so this file is just an adapter.
   ============================================================ */

"use strict";

const { handleApi, ready } = require("../lib/handler");

module.exports = async (req, res) => {
  try {
    await ready(); // ensure the Turso schema exists (memoized after first call)
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const url = new URL(req.url, `https://${host}`);
    return await handleApi(req, res, url);
  } catch (e) {
    console.error("[dump] API error:", e && e.stack ? e.stack : e);
    if (!res.headersSent) {
      const status = e && e.message === "Payload too large" ? 413 : 500;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: (e && e.message) || "Server error" }));
    }
  }
};
