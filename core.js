/* ============================================================
   Dump — shared core
   Detection engine · IndexedDB storage · icons · Groq AI
   Loaded by every page before its page-specific script.
   ============================================================ */

/* ---------------- Detection engine ---------------- */

const CATEGORIES = {
  reel:  { label: "Reel",  emoji: "🎬" },
  video: { label: "Video", emoji: "▶️" },
  doc:   { label: "Doc",   emoji: "📄" },
  photo: { label: "Photo", emoji: "🖼️" },
  link:  { label: "Link",  emoji: "🔗" },
  note:  { label: "Note",  emoji: "📝" },
};

function safeUrl(str) {
  try {
    const withProto = /^https?:\/\//i.test(str) ? str : "https://" + str;
    return new URL(withProto);
  } catch {
    return null;
  }
}

function looksLikeUrl(str) {
  const s = str.trim();
  if (/\s/.test(s)) return false;
  return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s);
}

/** Detect the type of a pasted string. */
function detectLink(raw) {
  const text = raw.trim();
  if (!looksLikeUrl(text)) {
    return { category: "note", title: text, url: null, domain: null, thumbnail: null };
  }
  const u = safeUrl(text);
  if (!u) return { category: "note", title: text, url: null, domain: null, thumbnail: null };

  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.toLowerCase();
  const full = u.href;
  const base = { url: full, domain: host, thumbnail: null };

  if (/(^|\.)instagram\.com$/.test(host)) {
    if (/\/(reel|reels|p|tv)\//.test(path)) return { ...base, category: "reel", title: "Instagram Reel", subtitle: host };
    return { ...base, category: "video", title: "Instagram post", subtitle: host };
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return { ...base, category: "reel", title: "TikTok video", subtitle: host };
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") {
    const id = youtubeId(u);
    const isShort = /\/shorts\//.test(path);
    return { ...base, category: isShort ? "reel" : "video", title: isShort ? "YouTube Short" : "YouTube video", subtitle: host, thumbnail: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null };
  }
  if (/(^|\.)vimeo\.com$/.test(host)) return { ...base, category: "video", title: "Vimeo video", subtitle: host };
  if (path.endsWith(".pdf")) return { ...base, category: "doc", title: filenameFromUrl(u) || "PDF document", subtitle: host };
  if (host === "docs.google.com") {
    let kind = "Google Doc";
    if (path.includes("/spreadsheets")) kind = "Google Sheet";
    else if (path.includes("/presentation")) kind = "Google Slides";
    else if (path.includes("/forms")) kind = "Google Form";
    return { ...base, category: "doc", title: kind, subtitle: host };
  }
  if (host === "drive.google.com") return { ...base, category: "doc", title: "Google Drive file", subtitle: host };
  if (/\.(docx?|pptx?|xlsx?|odt|rtf|txt|csv|key|pages)$/.test(path)) return { ...base, category: "doc", title: filenameFromUrl(u) || "Document", subtitle: host };
  if (/(^|\.)notion\.(so|site)$/.test(host) || host.includes("officeapps.live.com")) return { ...base, category: "doc", title: "Document", subtitle: host };
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(path)) return { ...base, category: "photo", title: filenameFromUrl(u) || "Image", subtitle: host, thumbnail: full };
  return { ...base, category: "link", title: prettyTitleFromUrl(u), subtitle: host };
}

function youtubeId(u) {
  if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
  if (u.searchParams.get("v")) return u.searchParams.get("v");
  const m = u.pathname.match(/\/(shorts|embed|v)\/([\w-]+)/);
  return m ? m[2] : null;
}
function filenameFromUrl(u) {
  const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
  return seg || null;
}
function prettyTitleFromUrl(u) {
  const seg = u.pathname.split("/").filter(Boolean).pop();
  if (seg) {
    return decodeURIComponent(seg).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
  }
  return u.hostname.replace(/^www\./, "");
}

/** Detect category for a dropped/selected File. */
function detectFile(file) {
  const type = file.type || "";
  const name = file.name || "file";
  if (type.startsWith("image/")) return { category: "photo", title: name };
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return { category: "doc", title: name };
  if (/\.(docx?|pptx?|xlsx?|odt|rtf|txt|csv|key|pages)$/i.test(name) || type.includes("officedocument") || type.includes("msword")) return { category: "doc", title: name };
  return { category: "link", title: name };
}

/* ---------------- Sections & buckets ---------------- */

// The four Dump sections used on page 1.
const SECTIONS = ["reels", "pdfs", "links", "screenshots"];
const SECTION_META = {
  reels:       { label: "Reels",       icon: "video" },
  pdfs:        { label: "PDFs & Docs", icon: "file-text" },
  links:       { label: "Links",       icon: "link" },
  screenshots: { label: "Screenshots", icon: "image" },
};

/** Rule-based mapping of a detected category to one of the four sections. */
function sectionOf(cat) {
  if (cat === "reel" || cat === "video") return "reels";
  if (cat === "doc") return "pdfs";
  if (cat === "photo") return "screenshots";
  return "links"; // link, note
}

/** Library sidebar bucket (page 2). */
function bucketOf(cat) {
  if (cat === "doc") return "docs";
  if (cat === "note") return "notes";
  if (cat === "photo") return "images";
  return "links";
}

/* ---------------- Groq AI classifier ----------------
   Optional: refines classification into one of the four sections.
   Falls back silently to the rule-based sectionOf() when no key
   is set or the request fails.                                        */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY_LS = "dump-groq-key";
const GROQ_TEXT_MODEL = "openai/gpt-oss-20b";
const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

function getGroqKey() { try { return localStorage.getItem(GROQ_KEY_LS) || ""; } catch { return ""; } }
function setGroqKey(k) { try { k ? localStorage.setItem(GROQ_KEY_LS, k.trim()) : localStorage.removeItem(GROQ_KEY_LS); } catch {} }
function hasGroq() { return !!getGroqKey(); }

const GROQ_SYSTEM =
  "You are a strict classifier. Put the item into exactly ONE of these four categories: " +
  "reels (short videos/reels — Instagram reels, TikTok, YouTube shorts, any video), " +
  "pdfs (PDFs and documents), " +
  "links (general web links, articles, notes, plain text), " +
  "screenshots (images, screenshots, photos). " +
  "Answer with ONLY the single category word: reels, pdfs, links, or screenshots.";

function normalizeSection(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("reel") || t.includes("video")) return "reels";
  if (t.includes("pdf") || t.includes("doc")) return "pdfs";
  if (t.includes("screenshot") || t.includes("image") || t.includes("photo")) return "screenshots";
  if (t.includes("link") || t.includes("note") || t.includes("article")) return "links";
  return null;
}

async function groqCall(model, messages) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${getGroqKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 12 }),
  });
  if (!res.ok) throw new Error("Groq HTTP " + res.status);
  const data = await res.json();
  return normalizeSection(data.choices?.[0]?.message?.content || "");
}

/**
 * Classify an item with Groq. Returns a section string, or null when
 * AI is unavailable / fails (caller should keep the rule-based section).
 */
async function aiClassify(item) {
  if (!hasGroq()) return null;
  try {
    if (item.kind === "file" && (item.mime || "").startsWith("image/") && item.blob) {
      const dataUrl = await blobToDataURL(item.blob);
      return await groqCall(GROQ_VISION_MODEL, [
        { role: "system", content: GROQ_SYSTEM },
        { role: "user", content: [
          { type: "text", text: "Classify this image into reels, pdfs, links, or screenshots." },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ]);
    }
    const content = item.url || item.note || item.title || "";
    return await groqCall(GROQ_TEXT_MODEL, [
      { role: "system", content: GROQ_SYSTEM },
      { role: "user", content: `Classify this item: ${content}` },
    ]);
  } catch (e) {
    console.warn("Groq classification failed:", e.message);
    return null;
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ---------------- Icons (Lucide-style, inline SVG) ---------------- */

const SVG = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  "book-open": SVG('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  "file-text": SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>'),
  notebook: SVG('<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M16 2v20"/>'),
  link: SVG('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  image: SVG('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>'),
  star: SVG('<path d="M11.5 2.5a.56.56 0 0 1 1 0l2.3 4.66c.08.17.24.29.43.31l5.15.75a.56.56 0 0 1 .31.96l-3.73 3.63a.56.56 0 0 0-.16.5l.88 5.12a.56.56 0 0 1-.81.59l-4.6-2.42a.56.56 0 0 0-.52 0l-4.6 2.42a.56.56 0 0 1-.81-.59l.88-5.12a.56.56 0 0 0-.16-.5L3.01 10.19a.56.56 0 0 1 .31-.96l5.15-.75a.56.56 0 0 0 .43-.31z"/>'),
  video: SVG('<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>'),
  search: SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  plus: SVG('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  "log-out": SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'),
  "arrow-up-down": SVG('<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>'),
  "arrow-right": SVG('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  "chevron-down": SVG('<path d="m6 9 6 6 6-6"/>'),
  trash: SVG('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
  external: SVG('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  upload: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
  check: SVG('<path d="M20 6 9 17l-5-5"/>'),
  sparkles: SVG('<path d="M9.94 14.34 9 21l-.94-6.66a2 2 0 0 0-1.4-1.4L0 12l6.66-.94a2 2 0 0 0 1.4-1.4L9 3l.94 6.66a2 2 0 0 0 1.4 1.4L18 12l-6.66.94a2 2 0 0 0-1.4 1.4z"/><path d="M20 3v4"/><path d="M22 5h-4"/>'),
  settings: SVG('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  pin: SVG('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
  folder: SVG('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
};

const TYPE_META = {
  reel:  { label: "Reel",  icon: "video" },
  video: { label: "Video", icon: "video" },
  doc:   { label: "Doc",   icon: "file-text" },
  photo: { label: "Image", icon: "image" },
  link:  { label: "Link",  icon: "link" },
  note:  { label: "Note",  icon: "notebook" },
};

function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.getAttribute("data-icon");
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });
}

/* ---------------- Shared helpers ---------------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function esc(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function humanSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function isToday(ts) {
  const d = new Date(ts), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

let _toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}
