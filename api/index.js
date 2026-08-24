/* ============================================================
   Dump — Vercel serverless entry point
   vercel.json rewrites every /api/* request to this single
   function, passing the real path in the __vpath query param.
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
    const incoming = new URL(req.url, `https://${host}`);

    // The rewrite passes the original path in __vpath. If Vercel instead
    // preserves the original req.url, __vpath is absent and we use pathname.
    // Either way we end up with the true /api/... path to route on.
    const vpath = incoming.searchParams.get("__vpath");
    const pathname = vpath || incoming.pathname;
    incoming.searchParams.delete("__vpath");

    const url = new URL(`https://${host}${pathname}`);
    for (const [k, v] of incoming.searchParams) url.searchParams.append(k, v);

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
