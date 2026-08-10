/* ============================================================
   Dump — personal resource vault
   Vanilla JS · IndexedDB · zero dependencies
   ============================================================ */

/* ---------------- 1. Detection engine ----------------
   Classifies a URL/string into a category and pulls out
   useful metadata (title, domain, thumbnail when possible).   */

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
    // add protocol if it looks like a bare domain
    const withProto = /^https?:\/\//i.test(str) ? str : "https://" + str;
    return new URL(withProto);
  } catch {
    return null;
  }
}

function looksLikeUrl(str) {
  const s = str.trim();
  if (/\s/.test(s)) return false; // multi-word => note, not a url
  return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s);
}

/**
 * Detect the type of a pasted string.
 * Returns { category, url, title, domain, thumbnail }
 */
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

  // --- Instagram ---
  if (/(^|\.)instagram\.com$/.test(host)) {
    if (/\/(reel|reels|p|tv)\//.test(path)) {
      return { ...base, category: "reel", title: "Instagram Reel", subtitle: host };
    }
    return { ...base, category: "video", title: "Instagram post", subtitle: host };
  }

  // --- TikTok ---
  if (/(^|\.)tiktok\.com$/.test(host)) {
    return { ...base, category: "reel", title: "TikTok video", subtitle: host };
  }

  // --- YouTube ---
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") {
    const id = youtubeId(u);
    const isShort = /\/shorts\//.test(path);
    return {
      ...base,
      category: isShort ? "reel" : "video",
      title: isShort ? "YouTube Short" : "YouTube video",
      subtitle: host,
      thumbnail: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
    };
  }

  // --- Vimeo ---
  if (/(^|\.)vimeo\.com$/.test(host)) {
    return { ...base, category: "video", title: "Vimeo video", subtitle: host };
  }

  // --- PDFs ---
  if (path.endsWith(".pdf")) {
    return { ...base, category: "doc", title: filenameFromUrl(u) || "PDF document", subtitle: host };
  }

  // --- Google Docs family ---
  if (host === "docs.google.com") {
    let kind = "Google Doc";
    if (path.includes("/spreadsheets")) kind = "Google Sheet";
    else if (path.includes("/presentation")) kind = "Google Slides";
    else if (path.includes("/forms")) kind = "Google Form";
    return { ...base, category: "doc", title: kind, subtitle: host };
  }
  if (host === "drive.google.com") {
    return { ...base, category: "doc", title: "Google Drive file", subtitle: host };
  }

  // --- Office / doc file extensions ---
  if (/\.(docx?|pptx?|xlsx?|odt|rtf|txt|csv|key|pages)$/.test(path)) {
    return { ...base, category: "doc", title: filenameFromUrl(u) || "Document", subtitle: host };
  }

  // Notion / office online
  if (/(^|\.)notion\.(so|site)$/.test(host) || host.includes("officeapps.live.com")) {
    return { ...base, category: "doc", title: "Document", subtitle: host };
  }

  // --- Direct image links ---
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(path)) {
    return { ...base, category: "photo", title: filenameFromUrl(u) || "Image", subtitle: host, thumbnail: full };
  }

  // --- Fallback: generic link ---
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
    return decodeURIComponent(seg)
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 80);
  }
  return u.hostname.replace(/^www\./, "");
}

/** Detect category for a dropped/selected File. */
function detectFile(file) {
  const type = file.type || "";
  const name = file.name || "file";
  if (type.startsWith("image/")) return { category: "photo", title: name };
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return { category: "doc", title: name };
  if (/\.(docx?|pptx?|xlsx?|odt|rtf|txt|csv|key|pages)$/i.test(name) || type.includes("officedocument") || type.includes("msword"))
    return { category: "doc", title: name };
  return { category: "link", title: name };
}

/* ---------------- 2. Storage layer (IndexedDB) ---------------- */

const DB_NAME = "dump-db";
const STORE = "items";
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("category", "category");
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- 3. App state & DOM refs ---------------- */

let items = [];          // in-memory cache of all items
let activeCat = "all";
let searchTerm = "";

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const emptyState = $("#emptyState");
const tabsEl = $("#tabs");
const countLabel = $("#countLabel");
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const linkInput = $("#linkInput");
const searchInput = $("#searchInput");
const toastEl = $("#toast");

/* ---------------- 4. Adding items ---------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addFromText(raw) {
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return;
  let added = 0;
  for (const part of parts) {
    const info = detectLink(part);
    const item = {
      id: uid(),
      createdAt: Date.now(),
      kind: info.url ? "link" : "note",
      category: info.category,
      title: info.title,
      subtitle: info.subtitle || info.domain || "",
      url: info.url,
      thumbnail: info.thumbnail || null,
      note: info.category === "note" ? info.title : null,
    };
    await dbPut(item);
    items.unshift(item);
    added++;
  }
  render();
  toast(added > 1 ? `Added ${added} items` : `Filed under ${CATEGORIES[items[0].category].label}`);
}

async function addFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    const info = detectFile(file);
    const item = {
      id: uid(),
      createdAt: Date.now(),
      kind: "file",
      category: info.category,
      title: info.title,
      subtitle: humanSize(file.size),
      url: null,
      blob: file,                       // stored directly in IndexedDB
      mime: file.type,
      thumbnail: null,
    };
    await dbPut(item);
    items.unshift(item);
  }
  render();
  toast(files.length > 1 ? `Added ${files.length} files` : "File filed away");
}

function humanSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function removeItem(id) {
  await dbDelete(id);
  items = items.filter((it) => it.id !== id);
  render();
  toast("Removed");
}

/* ---------------- 5. Rendering ---------------- */

const objectUrls = new Map();
function urlForBlob(item) {
  if (objectUrls.has(item.id)) return objectUrls.get(item.id);
  const url = URL.createObjectURL(item.blob);
  objectUrls.set(item.id, url);
  return url;
}

function gradientClass(cat) {
  return { reel: "gradient-1", video: "gradient-2", doc: "gradient-3", photo: "gradient-4", link: "gradient-2", note: "gradient-3" }[cat] || "gradient-2";
}

function mediaFor(item) {
  // Photos (files or image links) -> preview
  if (item.category === "photo") {
    const src = item.kind === "file" ? urlForBlob(item) : (item.thumbnail || item.url);
    if (src) return `<img loading="lazy" src="${escapeAttr(src)}" alt="${escapeAttr(item.title)}" />`;
  }
  // Video/reel with a thumbnail (e.g. YouTube)
  if (item.thumbnail) {
    return `<img loading="lazy" src="${escapeAttr(item.thumbnail)}" alt="${escapeAttr(item.title)}"
              onerror="this.parentNode.classList.add('${gradientClass(item.category)}');this.replaceWith(bigIcon('${item.category}'))" />`;
  }
  const emoji = CATEGORIES[item.category]?.emoji || "🔗";
  return `<span class="big-icon">${emoji}</span>`;
}

// used by onerror fallback above
window.bigIcon = function (cat) {
  const span = document.createElement("span");
  span.className = "big-icon";
  span.textContent = CATEGORIES[cat]?.emoji || "🔗";
  return span;
};

function cardHtml(item) {
  const cat = CATEGORIES[item.category] || CATEGORIES.link;

  if (item.category === "note") {
    return `
      <article class="card" data-id="${item.id}">
        <div class="card-body">
          <span class="type-badge" style="position:static;align-self:flex-start;background:var(--surface-2);color:var(--text-dim);border-color:var(--border)">${cat.emoji} Note</span>
          <p class="card-note">${escapeHtml(item.note || item.title)}</p>
          <div class="card-actions">
            <button class="card-del" title="Delete" data-del="${item.id}">🗑</button>
          </div>
        </div>
      </article>`;
  }

  const openBtn = item.kind === "file"
    ? `<a class="card-link" href="${escapeAttr(urlForBlob(item))}" target="_blank" rel="noopener" download="${escapeAttr(item.title)}">Open</a>`
    : item.url
      ? `<a class="card-link" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">Open</a>`
      : "";

  return `
    <article class="card" data-id="${item.id}">
      <div class="card-media ${gradientClass(item.category)}">
        <span class="type-badge">${cat.emoji} ${cat.label}</span>
        ${mediaFor(item)}
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <p class="card-sub">${escapeHtml(item.subtitle || item.url || "")}</p>
        <div class="card-actions">
          ${openBtn}
          <button class="card-del" title="Delete" data-del="${item.id}">🗑</button>
        </div>
      </div>
    </article>`;
}

function filteredItems() {
  return items.filter((it) => {
    if (activeCat !== "all" && it.category !== activeCat) return false;
    if (searchTerm) {
      const hay = `${it.title} ${it.subtitle} ${it.url || ""} ${it.note || ""}`.toLowerCase();
      if (!hay.includes(searchTerm)) return false;
    }
    return true;
  });
}

function render() {
  // counts
  const counts = { all: items.length, reel: 0, video: 0, doc: 0, photo: 0, link: 0, note: 0 };
  items.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
  document.querySelectorAll(".tab-count").forEach((el) => {
    el.textContent = counts[el.dataset.count] || 0;
  });

  countLabel.textContent = items.length
    ? `${items.length} item${items.length > 1 ? "s" : ""} saved`
    : "Nothing saved yet";

  const list = filteredItems();
  grid.innerHTML = list.map(cardHtml).join("");

  if (items.length === 0) {
    emptyState.classList.add("show");
    emptyState.querySelector("h3").textContent = "Nothing here yet";
    emptyState.querySelector("p").textContent = "Drop a file or paste a link above to start building your vault.";
  } else if (list.length === 0) {
    emptyState.classList.add("show");
    emptyState.querySelector("h3").textContent = "No matches";
    emptyState.querySelector("p").textContent = "Nothing in this view. Try another category or search.";
  } else {
    emptyState.classList.remove("show");
  }
}

/* ---------------- 6. Helpers ---------------- */

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str = "") { return escapeHtml(str); }

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ---------------- 7. Event wiring ---------------- */

// Paste / add link
$("#addLinkBtn").addEventListener("click", () => {
  if (linkInput.value.trim()) { addFromText(linkInput.value); linkInput.value = ""; }
});
linkInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && linkInput.value.trim()) { addFromText(linkInput.value); linkInput.value = ""; }
});

// File picker
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

// Dropzone click -> open picker
dropzone.addEventListener("click", (e) => { if (!e.target.closest(".file-pick")) fileInput.click(); });
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });

// Drag & drop (whole window highlights the zone)
["dragenter", "dragover"].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && e.relatedTarget) return;
    dropzone.classList.remove("dragover");
  })
);
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (dt.files && dt.files.length) { addFiles(dt.files); return; }
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) addFromText(text);
});

// Grid actions (event delegation)
grid.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { removeItem(del.getAttribute("data-del")); }
});

// Tabs
tabsEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  activeCat = tab.dataset.cat;
  render();
});

// Search
searchInput.addEventListener("input", () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });

// Theme toggle
const themeToggle = $("#themeToggle");
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("dump-theme", t); } catch {}
}
themeToggle.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyTheme(cur === "light" ? "dark" : "light");
});

/* ---------------- 8. Boot ---------------- */

(async function init() {
  try { applyTheme(localStorage.getItem("dump-theme") || "dark"); } catch { applyTheme("dark"); }
  try {
    items = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error("Failed to load from IndexedDB", err);
    items = [];
  }
  render();
})();
