/* ============================================================
   Dump — full-stack backend (zero dependencies)
   Node built-ins only: http, node:sqlite, crypto, fs, path.
   Run:  node --experimental-sqlite server/server.js
   ============================================================ */

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");          // static frontend root
const DATA_DIR = path.join(__dirname, "data");
const PORT = process.env.PORT || 4000;
const MAX_BODY = 20 * 1024 * 1024;                 // 20 MB (files as base64)

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- Secret (persisted) ---------------- */
const SECRET = (() => {
  if (process.env.DUMP_JWT_SECRET) return process.env.DUMP_JWT_SECRET;
  const f = path.join(DATA_DIR, ".secret");
  try { return fs.readFileSync(f, "utf8"); }
  catch {
    const s = crypto.randomBytes(48).toString("hex");
    try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
    return s;
  }
})();

/* ---------------- Database ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, "dump.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT,
    category TEXT,
    section TEXT,
    title TEXT,
    subtitle TEXT,
    url TEXT,
    note TEXT,
    thumbnail TEXT,
    mime TEXT,
    file_name TEXT,
    file_data BLOB,
    approved INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
`);

/* ---------------- Crypto helpers ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
function verifyPassword(pw, saltHex, hashHex) {
  try {
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch { return false; }
}
function b64url(input) { return Buffer.from(input).toString("base64url"); }
function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}
function uid() { return crypto.randomBytes(9).toString("base64url"); }

/* ---------------- HTTP helpers ---------------- */
function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function authUser(req, url) {
  const header = req.headers["authorization"] || "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token && url) token = url.searchParams.get("token");
  const payload = verifyToken(token);
  if (!payload || !payload.uid) return null;
  return db.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(payload.uid) || null;
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, createdAt: u.created_at }; }
function issueToken(userId) { return signToken({ uid: userId, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); }

function rowToItem(r) {
  return {
    id: r.id, kind: r.kind, category: r.category, section: r.section,
    title: r.title, subtitle: r.subtitle, url: r.url, note: r.note,
    thumbnail: r.thumbnail, mime: r.mime,
    approved: !!r.approved, starred: !!r.starred, createdAt: r.created_at,
    hasFile: !!r.file_name,
    fileUrl: r.file_name ? `/api/files/${r.id}` : null,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------- API router ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // --- Auth ---
  if (p === "/api/auth/signup" && method === "POST") {
    const b = await readJson(req);
    const name = (b.name || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    const password = b.password || "";
    if (!name) return send(res, 400, { error: "Please enter your name." });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: "Enter a valid email address." });
    if (password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email))
      return send(res, 409, { error: "An account with this email already exists." });
    const { salt, hash } = hashPassword(password);
    const id = uid();
    db.prepare("INSERT INTO users (id, name, email, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, name, email, hash, salt, Date.now());
    const user = db.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(id);
    return send(res, 201, { token: issueToken(id), user: publicUser(user) });
  }

  if (p === "/api/auth/login" && method === "POST") {
    const b = await readJson(req);
    const email = (b.email || "").trim().toLowerCase();
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!row || !verifyPassword(b.password || "", row.pass_salt, row.pass_hash))
      return send(res, 401, { error: "Wrong email or password." });
    return send(res, 200, { token: issueToken(row.id), user: publicUser(row) });
  }

  if (p === "/api/auth/me" && method === "GET") {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    return send(res, 200, { user: publicUser(user) });
  }

  // --- File serving (token via query for <img>/<a>) ---
  const fileMatch = p.match(/^\/api\/files\/([\w-]+)$/);
  if (fileMatch && method === "GET") {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = db.prepare("SELECT mime, file_name, file_data FROM items WHERE id = ? AND user_id = ?").get(fileMatch[1], user.id);
    if (!row || !row.file_data) return send(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": row.mime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${(row.file_name || "file").replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    });
    return res.end(Buffer.from(row.file_data));
  }

  // --- Items (all protected) ---
  if (p === "/api/items" && method === "GET") {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    let rows;
    if (url.searchParams.has("approved")) {
      const ap = url.searchParams.get("approved") === "true" ? 1 : 0;
      rows = db.prepare("SELECT * FROM items WHERE user_id = ? AND approved = ? ORDER BY created_at DESC").all(user.id, ap);
    } else {
      rows = db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
    }
    return send(res, 200, { items: rows.map(rowToItem) });
  }

  if (p === "/api/items" && method === "POST") {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const b = await readJson(req);
    const id = uid();
    let fileBuf = null, mime = b.mime || null, fileName = null;
    if (b.fileData) {
      const base64 = String(b.fileData).replace(/^data:[^;]+;base64,/, "");
      fileBuf = Buffer.from(base64, "base64");
      fileName = b.fileName || b.title || "file";
    }
    db.prepare(`INSERT INTO items
      (id, user_id, kind, category, section, title, subtitle, url, note, thumbnail, mime, file_name, file_data, approved, starred, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, user.id, b.kind || null, b.category || null, b.section || null,
      b.title || null, b.subtitle || null, b.url || null, b.note || null,
      b.thumbnail || null, mime, fileName, fileBuf,
      b.approved ? 1 : 0, b.starred ? 1 : 0, Date.now()
    );
    const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return send(res, 201, { item: rowToItem(row) });
  }

  const itemMatch = p.match(/^\/api\/items\/([\w-]+)$/);
  if (itemMatch && (method === "PATCH" || method === "PUT")) {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = db.prepare("SELECT id FROM items WHERE id = ? AND user_id = ?").get(itemMatch[1], user.id);
    if (!row) return send(res, 404, { error: "Not found" });
    const b = await readJson(req);
    const sets = [], vals = [];
    if (typeof b.section === "string") { sets.push("section = ?"); vals.push(b.section); }
    if (typeof b.approved === "boolean") { sets.push("approved = ?"); vals.push(b.approved ? 1 : 0); }
    if (typeof b.starred === "boolean") { sets.push("starred = ?"); vals.push(b.starred ? 1 : 0); }
    if (typeof b.title === "string") { sets.push("title = ?"); vals.push(b.title); }
    if (!sets.length) return send(res, 400, { error: "Nothing to update" });
    vals.push(itemMatch[1], user.id);
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
    return send(res, 200, { item: rowToItem(db.prepare("SELECT * FROM items WHERE id = ?").get(itemMatch[1])) });
  }

  if (itemMatch && method === "DELETE") {
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    db.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").run(itemMatch[1], user.id);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Unknown endpoint" });
}

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
  // never serve the server dir or data
  if (filePath.startsWith(path.join(ROOT, "server"))) { res.writeHead(404); return res.end("Not found"); }
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
  catch { return send(res, 400, { error: "Bad request" }); }

  if (url.pathname.startsWith("/api/")) {
    try { return await handleApi(req, res, url); }
    catch (e) {
      if (!res.headersSent) return send(res, e.message === "Payload too large" ? 413 : 400, { error: e.message || "Server error" });
    }
  } else {
    return serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, () => console.log(`Dump server running at http://localhost:${PORT}`));
