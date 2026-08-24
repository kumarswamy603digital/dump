/* ============================================================
   Dump — shared API handler (async / libSQL)
   Single source of truth for every /api/* endpoint. Used by:
     • api/[...path].js   (Vercel serverless)
     • server/server.js   (local Node server)

   Uses the libSQL helpers from ./db, so every DB call is awaited.
   ============================================================ */

"use strict";

const crypto = require("node:crypto");
const { ready, all, get, run } = require("./db");

const MAX_BODY = 20 * 1024 * 1024; // 20 MB (files arrive as base64)

/* ---------------- Secret ---------------- */
// On serverless there is no writable disk, so the secret MUST come from the
// environment. The local server sets DUMP_JWT_SECRET (from a persisted file)
// before requiring this module, so tokens survive restarts there too.
const SECRET = process.env.DUMP_JWT_SECRET || crypto.randomBytes(48).toString("hex");
if (!process.env.DUMP_JWT_SECRET) {
  console.warn(
    "[dump] DUMP_JWT_SECRET is not set — using an ephemeral secret. " +
    "Set it in your environment (Vercel → Project → Settings → Environment Variables) " +
    "so logins survive restarts and cold starts."
  );
}

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

// Normalize a URL for duplicate detection (drop www, trailing slash, hash, tracking params).
function normUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u);
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "igshid", "si", "usp"].forEach((p) => url.searchParams.delete(p));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return host + path + (url.search || "");
  } catch { return (u || "").trim(); }
}

/* ---------------- HTTP helpers ---------------- */
function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

// Reads a JSON body from either a pre-parsed request (Vercel may set req.body)
// or the raw stream (local Node server).
function readJson(req) {
  const b = req.body;
  if (b !== undefined && b !== null) {
    if (typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    const str = Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    if (!str.trim()) return Promise.resolve({});
    try { return Promise.resolve(JSON.parse(str)); }
    catch { return Promise.reject(new Error("Invalid JSON")); }
  }
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

async function authUser(req, url) {
  const header = req.headers["authorization"] || "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token && url) token = url.searchParams.get("token");
  const payload = verifyToken(token);
  if (!payload || !payload.uid) return null;
  return (await get("SELECT id, name, email, created_at FROM users WHERE id = ?", [payload.uid])) || null;
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, createdAt: u.created_at }; }
function issueToken(userId) { return signToken({ uid: userId, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); }

// Turso returns BLOB columns as ArrayBuffer/Uint8Array — normalize to a Buffer.
function toBuffer(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v);
}

// Fetch a remote PDF (with timeout + size cap) so it can be stored locally.
async function fetchRemotePdf(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const r = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "DumpBot/1.0" } });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("pdf") && !/\.pdf(\?|#|$)/i.test(url)) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > 25 * 1024 * 1024) return null;
    let name = "document.pdf";
    try { name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "document.pdf"); } catch {}
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    return { buf: Buffer.from(ab), name };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Fetch a page's Open Graph cover image (first frame for reels/videos, hero for links).
async function fetchOgImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: controller.signal, redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DumpBot/1.0; +https://dump.app)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("html")) return null;

    // Read only the first ~600 KB (og tags live in <head>).
    let html = "", received = 0;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += dec.decode(value, { stream: true });
      if (received > 600 * 1024 || /<\/head>/i.test(html)) { try { await reader.cancel(); } catch {} break; }
    }

    const m =
      html.match(/<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image(?::secure_url)?["']/i) ||
      html.match(/<meta[^>]+(?:property|name)=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
    if (!m) return null;
    let img = m[1].replace(/&amp;/g, "&").trim();
    try { img = new URL(img, r.url || url).href; } catch {}
    return img || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/* ---------------- AI (Groq) + OCR — server-side ---------------- */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";
const OCR_API_KEY = process.env.OCR_API_KEY || "";
const OCR_URL = process.env.OCR_URL || "https://api.ocr.space/parse/image";

async function withTimeout(factory, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await factory(c.signal); } finally { clearTimeout(t); }
}

async function groqChat(model, messages, maxTokens = 16) {
  if (!GROQ_API_KEY) return "";
  const r = await withTimeout((signal) => fetch(GROQ_URL, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
  }), 12000);
  if (!r.ok) throw new Error("Groq HTTP " + r.status);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}

function normalizeSection(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("reel") || t.includes("video")) return "reels";
  if (t.includes("pdf") || t.includes("doc")) return "pdfs";
  if (t.includes("screenshot") || t.includes("image") || t.includes("photo")) return "screenshots";
  if (t.includes("link") || t.includes("note") || t.includes("article")) return "links";
  return null;
}
const CLASSIFY_SYSTEM =
  "You are a strict classifier. Reply with ONLY one word — reels, pdfs, links, or screenshots. " +
  "reels = short videos/reels (Instagram, TikTok, YouTube). pdfs = PDFs/documents. " +
  "links = general web links, articles, notes. screenshots = images/photos.";

async function classifyText({ url, title, note }) {
  if (!GROQ_API_KEY) return null;
  try {
    const content = url || note || title || "";
    if (!content) return null;
    return normalizeSection(await groqChat(GROQ_TEXT_MODEL, [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: `Classify this item: ${content}` },
    ], 8));
  } catch (e) { console.warn("classifyText failed:", e.message); return null; }
}

async function ocrViaOcrSpace(buf, mime) {
  // OCR.space free tier caps uploads at ~1 MB; warn but still try.
  if (buf.length > 1024 * 1024) console.warn(`OCR.space: image is ${(buf.length / 1048576).toFixed(1)} MB (free tier limit ~1 MB).`);
  const body = new URLSearchParams();
  body.set("base64Image", `data:${mime || "image/png"};base64,${buf.toString("base64")}`);
  body.set("language", "eng");
  body.set("OCREngine", "2");
  body.set("scale", "true");
  body.set("isOverlayRequired", "false");
  body.set("detectOrientation", "true");
  const r = await withTimeout((signal) => fetch(OCR_URL, {
    method: "POST", signal,
    headers: { apikey: OCR_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), 15000);
  if (!r.ok) throw new Error("OCR HTTP " + r.status);
  const data = await r.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : (data.ErrorMessage || "unknown error");
    throw new Error("OCR.space: " + msg);
  }
  const text = (data.ParsedResults || []).map((p) => p.ParsedText || "").join("\n").trim();
  console.log(`OCR.space read ${text.length} chars from screenshot.`);
  return text;
}

async function ocrViaGroqVision(buf, mime) {
  const dataUrl = `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
  return await groqChat(GROQ_VISION_MODEL, [
    { role: "user", content: [
      { type: "text", text: "Extract ALL text visible in this image, especially any URLs or links. Return only the raw extracted text, nothing else." },
      { type: "image_url", image_url: { url: dataUrl } },
    ] },
  ], 512);
}

async function ocrImageBuffer(buf, mime) {
  if (OCR_API_KEY) { try { return await ocrViaOcrSpace(buf, mime); } catch (e) { console.warn("OCR.space failed:", e.message); } }
  if (GROQ_API_KEY) { try { return await ocrViaGroqVision(buf, mime); } catch (e) { console.warn("Groq OCR failed:", e.message); } }
  return "";
}

const COMMON_TLDS = new Set("com,org,net,io,co,ai,dev,app,me,gov,edu,in,uk,us,ca,au,de,fr,jp,so,site,xyz,tech,info,news,tv".split(","));
function extractUrls(text) {
  if (!text) return [];
  const re = /((https?:\/\/)?(www\.)?[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/[^\s"'<>)\]]*)?)/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) {
    let u = m[0].trim().replace(/[.,);\]]+$/, "");
    const hasProto = /^https?:\/\//i.test(u);
    const hasWww = /^www\./i.test(u);
    const hasPath = u.includes("/");
    const tld = (u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].split(".").pop() || "").toLowerCase();
    if (!hasProto && !hasWww && !hasPath && !COMMON_TLDS.has(tld)) continue;
    if (!hasProto) u = "https://" + u;
    out.add(u);
    if (out.size >= 10) break;
  }
  return [...out];
}

function rowToItem(r) {
  return {
    id: r.id, kind: r.kind, category: r.category, section: r.section,
    title: r.title, subtitle: r.subtitle, url: r.url, note: r.note,
    thumbnail: r.thumbnail, mime: r.mime,
    approved: !!r.approved, starred: !!r.starred, pinned: !!r.pinned,
    sectionId: r.section_id || null, annotation: r.annotation || "", createdAt: r.created_at,
    hasFile: !!r.file_name,
    fileUrl: r.file_name ? `/api/files/${r.id}` : null,
    hasCover: !!r.cover_mime,
    coverUrl: r.cover_mime ? `/api/covers/${r.id}` : null,
    parentId: r.parent_id || null,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------- API router ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // --- Public capability flags (no secrets) — confirm what's wired ---
  if (p === "/api/config" && method === "GET") {
    return send(res, 200, {
      aiClassify: !!GROQ_API_KEY,
      ocr: OCR_API_KEY ? "ocr.space" : (GROQ_API_KEY ? "groq-vision" : "off"),
    });
  }

  // --- Auth ---
  if (p === "/api/auth/signup" && method === "POST") {
    const b = await readJson(req);
    const name = (b.name || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    const password = b.password || "";
    if (!name) return send(res, 400, { error: "Please enter your name." });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: "Enter a valid email address." });
    if (password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
    if (await get("SELECT 1 FROM users WHERE email = ?", [email]))
      return send(res, 409, { error: "An account with this email already exists." });
    const { salt, hash } = hashPassword(password);
    const id = uid();
    await run("INSERT INTO users (id, name, email, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)",
      [id, name, email, hash, salt, Date.now()]);
    const user = await get("SELECT id, name, email, created_at FROM users WHERE id = ?", [id]);
    return send(res, 201, { token: issueToken(id), user: publicUser(user) });
  }

  if (p === "/api/auth/login" && method === "POST") {
    const b = await readJson(req);
    const email = (b.email || "").trim().toLowerCase();
    const row = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!row || !verifyPassword(b.password || "", row.pass_salt, row.pass_hash))
      return send(res, 401, { error: "Wrong email or password." });
    return send(res, 200, { token: issueToken(row.id), user: publicUser(row) });
  }

  if (p === "/api/auth/me" && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    return send(res, 200, { user: publicUser(user) });
  }

  if (p === "/api/auth/me" && method === "PATCH") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const b = await readJson(req);
    const sets = [], vals = [];
    if (typeof b.name === "string") {
      const n = b.name.trim();
      if (!n) return send(res, 400, { error: "Name can't be empty." });
      sets.push("name = ?"); vals.push(n);
    }
    if (typeof b.email === "string") {
      const em = b.email.trim().toLowerCase();
      if (!EMAIL_RE.test(em)) return send(res, 400, { error: "Enter a valid email address." });
      if (await get("SELECT 1 FROM users WHERE email = ? AND id <> ?", [em, user.id]))
        return send(res, 409, { error: "That email is already in use." });
      sets.push("email = ?"); vals.push(em);
    }
    if (!sets.length) return send(res, 400, { error: "Nothing to update." });
    vals.push(user.id);
    await run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, vals);
    const updated = await get("SELECT id, name, email, created_at FROM users WHERE id = ?", [user.id]);
    return send(res, 200, { user: publicUser(updated) });
  }

  if (p === "/api/auth/password" && method === "POST") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const b = await readJson(req);
    const row = await get("SELECT * FROM users WHERE id = ?", [user.id]);
    if (!verifyPassword(b.currentPassword || "", row.pass_salt, row.pass_hash))
      return send(res, 400, { error: "Your current password is incorrect." });
    if (!b.newPassword || b.newPassword.length < 6)
      return send(res, 400, { error: "New password must be at least 6 characters." });
    const { salt, hash } = hashPassword(b.newPassword);
    await run("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?", [hash, salt, user.id]);
    return send(res, 200, { ok: true });
  }

  if (p === "/api/stats" && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const c = async (sql, ...a) => (await get(sql, [user.id, ...a])).c;
    const total = await c("SELECT COUNT(*) c FROM items WHERE user_id = ? AND approved = 1");
    const staged = await c("SELECT COUNT(*) c FROM items WHERE user_id = ? AND approved = 0");
    const pinned = await c("SELECT COUNT(*) c FROM items WHERE user_id = ? AND pinned = 1");
    const sectionCount = await c("SELECT COUNT(*) c FROM sections WHERE user_id = ?");
    const rows = await all("SELECT category, COUNT(*) c FROM items WHERE user_id = ? AND approved = 1 GROUP BY category", [user.id]);
    const byType = { reels: 0, pdfs: 0, links: 0, images: 0, notes: 0 };
    for (const r of rows) {
      const cat = r.category;
      if (cat === "reel" || cat === "video") byType.reels += r.c;
      else if (cat === "doc") byType.pdfs += r.c;
      else if (cat === "photo") byType.images += r.c;
      else if (cat === "note") byType.notes += r.c;
      else byType.links += r.c;
    }
    return send(res, 200, { stats: { total, staged, pinned, sections: sectionCount, byType } });
  }

  if (p === "/api/account" && method === "DELETE") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    await run("DELETE FROM items WHERE user_id = ?", [user.id]);
    await run("DELETE FROM sections WHERE user_id = ?", [user.id]);
    await run("DELETE FROM users WHERE id = ?", [user.id]);
    return send(res, 200, { ok: true });
  }

  // --- Sections (custom collections) ---
  if (p === "/api/sections" && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const rows = await all(
      `SELECT s.id, s.name, s.created_at,
              (SELECT COUNT(*) FROM items i WHERE i.section_id = s.id) AS cnt
       FROM sections s WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      [user.id]
    );
    return send(res, 200, { sections: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, count: r.cnt })) });
  }

  if (p === "/api/sections" && method === "POST") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const b = await readJson(req);
    const name = (b.name || "").trim();
    if (!name) return send(res, 400, { error: "Section name is required." });
    if (name.length > 60) return send(res, 400, { error: "Section name is too long." });
    if (await get("SELECT 1 FROM sections WHERE user_id = ? AND lower(name) = lower(?)", [user.id, name]))
      return send(res, 409, { error: "You already have a section with that name." });
    const id = uid();
    const now = Date.now();
    await run("INSERT INTO sections (id, user_id, name, created_at) VALUES (?,?,?,?)", [id, user.id, name, now]);
    return send(res, 201, { section: { id, name, createdAt: now, count: 0 } });
  }

  const sectionMatch = p.match(/^\/api\/sections\/([\w-]+)$/);
  if (sectionMatch && method === "DELETE") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    await run("UPDATE items SET section_id = NULL WHERE section_id = ? AND user_id = ?", [sectionMatch[1], user.id]);
    await run("DELETE FROM sections WHERE id = ? AND user_id = ?", [sectionMatch[1], user.id]);
    return send(res, 200, { ok: true });
  }

  // --- File serving (token via query for <img>/<a>) ---
  const fileMatch = p.match(/^\/api\/files\/([\w-]+)$/);
  if (fileMatch && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = await get("SELECT mime, file_name, file_data FROM items WHERE id = ? AND user_id = ?", [fileMatch[1], user.id]);
    if (!row || !row.file_data) return send(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": row.mime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${(row.file_name || "file").replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    });
    return res.end(toBuffer(row.file_data));
  }

  // --- Custom cover image serving ---
  const coverMatch = p.match(/^\/api\/covers\/([\w-]+)$/);
  if (coverMatch && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = await get("SELECT cover_mime, cover_data FROM items WHERE id = ? AND user_id = ?", [coverMatch[1], user.id]);
    if (!row || !row.cover_data) return send(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": row.cover_mime || "image/png", "Cache-Control": "private, max-age=3600" });
    return res.end(toBuffer(row.cover_data));
  }

  // --- Set a custom cover image on any item ---
  const coverSetMatch = p.match(/^\/api\/items\/([\w-]+)\/cover$/);
  if (coverSetMatch && method === "POST") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = await get("SELECT id FROM items WHERE id = ? AND user_id = ?", [coverSetMatch[1], user.id]);
    if (!row) return send(res, 404, { error: "Not found" });
    const b = await readJson(req);
    if (!b.fileData) return send(res, 400, { error: "No image provided." });
    const mimeMatch = /^data:([^;]+);base64,/.exec(String(b.fileData));
    const cmime = (mimeMatch && mimeMatch[1]) || b.mime || "image/png";
    if (!cmime.startsWith("image/")) return send(res, 400, { error: "Cover must be an image." });
    const buf = Buffer.from(String(b.fileData).replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!buf.length) return send(res, 400, { error: "Empty image." });
    await run("UPDATE items SET cover_data = ?, cover_mime = ? WHERE id = ? AND user_id = ?", [buf, cmime, coverSetMatch[1], user.id]);
    return send(res, 200, { item: rowToItem(await get("SELECT * FROM items WHERE id = ?", [coverSetMatch[1]])) });
  }

  // --- Items (all protected) ---
  // --- Remove duplicate items (same normalized URL) — keeps the best copy ---
  if (p === "/api/items/dedupe" && method === "POST") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const rows = await all("SELECT * FROM items WHERE user_id = ? AND url IS NOT NULL ORDER BY created_at ASC", [user.id]);
    const groups = new Map();
    for (const r of rows) {
      const nk = normUrl(r.url); if (!nk) continue;
      const k = (r.parent_id || "") + "|" + nk; // dedupe within the same container
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const score = (r) => (r.approved ? 8 : 0) + (r.cover_mime ? 4 : 0) + ((r.annotation && r.annotation.trim()) ? 2 : 0) + (r.pinned ? 1 : 0) + (r.starred ? 1 : 0);
    let removed = 0;
    for (const [, arr] of groups) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => score(b) - score(a) || a.created_at - b.created_at); // keep highest score, then oldest
      for (const r of arr.slice(1)) { await run("DELETE FROM items WHERE id = ? AND user_id = ?", [r.id, user.id]); removed++; }
    }
    return send(res, 200, { removed });
  }

  if (p === "/api/items" && method === "GET") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    let rows;
    if (url.searchParams.has("approved")) {
      const ap = url.searchParams.get("approved") === "true" ? 1 : 0;
      rows = await all("SELECT * FROM items WHERE user_id = ? AND approved = ? ORDER BY created_at DESC", [user.id, ap]);
    } else {
      rows = await all("SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC", [user.id]);
    }
    return send(res, 200, { items: rows.map(rowToItem) });
  }

  if (p === "/api/items" && method === "POST") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const b = await readJson(req);

    // De-duplicate: if this URL already exists for the user, return the existing item.
    if (b.url) {
      const nu = normUrl(b.url);
      const pid = b.parent_id || null;
      const dup = (await all("SELECT * FROM items WHERE user_id = ? AND url IS NOT NULL", [user.id]))
        .find((r) => (r.parent_id || null) === pid && normUrl(r.url) === nu);
      if (dup) return send(res, 200, { item: rowToItem(dup), duplicate: true, ocrUrls: [] });
    }

    const id = uid();
    let fileBuf = null, mime = b.mime || null, fileName = null;
    if (b.fileData) {
      const base64 = String(b.fileData).replace(/^data:[^;]+;base64,/, "");
      fileBuf = Buffer.from(base64, "base64");
      fileName = b.fileName || b.title || "file";
    }
    // Auto-capture PDF links: fetch the file server-side so it's stored & previewable.
    if (!fileBuf && b.url && /\.pdf(\?|#|$)/i.test(b.url)) {
      const pdf = await fetchRemotePdf(b.url);
      if (pdf) { fileBuf = pdf.buf; mime = "application/pdf"; fileName = pdf.name; }
    }

    const isImage = (mime || "").startsWith("image/");

    // Server-side AI classification + cover-image (first frame) fetch — in parallel.
    let section = b.section || null;
    let thumbnail = b.thumbnail || null;
    if (b.analyze !== false && !isImage && !fileBuf && (b.url || b.note || b.title)) {
      const needCover = b.url && !thumbnail && ["reel", "video", "link"].includes(b.category);
      const [c, og] = await Promise.all([
        classifyText({ url: b.url, title: b.title, note: b.note }),
        needCover ? fetchOgImage(b.url) : Promise.resolve(null),
      ]);
      if (c) section = c;
      if (og) thumbnail = og;
    }

    // Validate an optional parent (attaching to a reel/container).
    let parentId = null;
    if (b.parent_id) {
      const par = await get("SELECT id FROM items WHERE id = ? AND user_id = ?", [b.parent_id, user.id]);
      if (par) parentId = b.parent_id;
    }

    await run(
      `INSERT INTO items
      (id, user_id, kind, category, section, title, subtitle, url, note, thumbnail, mime, file_name, file_data, approved, starred, pinned, parent_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, user.id, b.kind || null, b.category || null, section,
        b.title || null, b.subtitle || null, b.url || null, b.note || null,
        thumbnail, mime, fileName, fileBuf,
        b.approved ? 1 : 0, b.starred ? 1 : 0, b.pinned ? 1 : 0, parentId, Date.now(),
      ]
    );
    const row = await get("SELECT * FROM items WHERE id = ?", [id]);

    // OCR screenshots: extract any links found inside the image (skipped for direct adds).
    let ocrUrls = [];
    if (b.analyze !== false && isImage && fileBuf) {
      try { ocrUrls = extractUrls(await ocrImageBuffer(fileBuf, mime)); } catch {}
    }
    return send(res, 201, { item: rowToItem(row), ocrUrls });
  }

  const itemMatch = p.match(/^\/api\/items\/([\w-]+)$/);
  if (itemMatch && (method === "PATCH" || method === "PUT")) {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    const row = await get("SELECT id FROM items WHERE id = ? AND user_id = ?", [itemMatch[1], user.id]);
    if (!row) return send(res, 404, { error: "Not found" });
    const b = await readJson(req);
    const sets = [], vals = [];
    if (typeof b.section === "string") { sets.push("section = ?"); vals.push(b.section); }
    if (typeof b.approved === "boolean") { sets.push("approved = ?"); vals.push(b.approved ? 1 : 0); }
    if (typeof b.starred === "boolean") { sets.push("starred = ?"); vals.push(b.starred ? 1 : 0); }
    if (typeof b.pinned === "boolean") { sets.push("pinned = ?"); vals.push(b.pinned ? 1 : 0); }
    if (typeof b.annotation === "string") { sets.push("annotation = ?"); vals.push(b.annotation); }
    if ("section_id" in b) {
      if (b.section_id) {
        const s = await get("SELECT id FROM sections WHERE id = ? AND user_id = ?", [b.section_id, user.id]);
        if (!s) return send(res, 400, { error: "Unknown section" });
        sets.push("section_id = ?"); vals.push(b.section_id);
      } else { sets.push("section_id = ?"); vals.push(null); }
    }
    if ("parent_id" in b) {
      if (b.parent_id) {
        const par = await get("SELECT id FROM items WHERE id = ? AND user_id = ?", [b.parent_id, user.id]);
        if (!par) return send(res, 400, { error: "Unknown parent" });
        sets.push("parent_id = ?"); vals.push(b.parent_id);
      } else { sets.push("parent_id = ?"); vals.push(null); }
    }
    if (typeof b.title === "string") { sets.push("title = ?"); vals.push(b.title); }
    if (!sets.length) return send(res, 400, { error: "Nothing to update" });
    vals.push(itemMatch[1], user.id);
    await run(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, vals);
    return send(res, 200, { item: rowToItem(await get("SELECT * FROM items WHERE id = ?", [itemMatch[1]])) });
  }

  if (itemMatch && method === "DELETE") {
    const user = await authUser(req, url);
    if (!user) return send(res, 401, { error: "Not authenticated" });
    // Delete the item and any attachments it holds (attachments live with their reel).
    await run("DELETE FROM items WHERE (id = ? OR parent_id = ?) AND user_id = ?", [itemMatch[1], itemMatch[1], user.id]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Unknown endpoint" });
}

module.exports = { handleApi, ready, MAX_BODY };
