/* ============================================================
   Research Workspace — calm research vault
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
 * Returns { category, url, title, domain, thumbnail, subtitle }
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

/* ---------------- 3. Icons (Lucide-style, inline SVG) ---------------- */

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
  "chevron-down": SVG('<path d="m6 9 6 6 6-6"/>'),
  trash: SVG('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
  external: SVG('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  upload: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
};

const TYPE_META = {
  reel:  { label: "Reel",  icon: "video" },
  video: { label: "Video", icon: "video" },
  doc:   { label: "Doc",   icon: "file-text" },
  photo: { label: "Image", icon: "image" },
  link:  { label: "Link",  icon: "link" },
  note:  { label: "Note",  icon: "notebook" },
};

/** Which sidebar bucket a detected category belongs to. */
function bucketOf(cat) {
  if (cat === "doc") return "docs";
  if (cat === "note") return "notes";
  if (cat === "photo") return "images";
  return "links"; // link, reel, video
}

function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.getAttribute("data-icon");
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });
}

/* ---------------- 4. State & DOM refs ---------------- */

let items = [];
let activeView = "all";        // all | docs | notes | links | images | starred
let searchTerm = "";
let sortOrder = "new";         // new | old | az

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const emptyState = $("#emptyState");
const emptyTitle = $("#emptyTitle");
const emptyText = $("#emptyText");
const countLabel = $("#countLabel");
const fileInput = $("#fileInput");
const linkInput = $("#linkInput");
const searchInput = $("#searchInput");
const sortSelect = $("#sortSelect");
const toastEl = $("#toast");
const nav = $("#nav");
const modalOverlay = $("#modalOverlay");
const dropOverlay = $("#dropOverlay");

/* ---------------- 5. Adding / mutating items ---------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addFromText(raw) {
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return;
  let added = 0;
  let lastCat = null;
  for (const part of parts) {
    const info = detectLink(part);
    const item = {
      id: uid(),
      createdAt: Date.now() + added,
      kind: info.url ? "link" : "note",
      category: info.category,
      title: info.title,
      subtitle: info.subtitle || info.domain || "",
      url: info.url,
      thumbnail: info.thumbnail || null,
      note: info.category === "note" ? info.title : null,
      starred: false,
    };
    await dbPut(item);
    items.unshift(item);
    lastCat = info.category;
    added++;
  }
  render();
  toast(added > 1 ? `Added ${added} items` : `Saved to ${capitalize(bucketOf(lastCat))}`);
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
      blob: file,
      mime: file.type,
      thumbnail: null,
      starred: false,
    };
    await dbPut(item);
    items.unshift(item);
  }
  render();
  toast(files.length > 1 ? `Uploaded ${files.length} files` : "File uploaded");
}

async function removeItem(id) {
  await dbDelete(id);
  if (objectUrls.has(id)) { URL.revokeObjectURL(objectUrls.get(id)); objectUrls.delete(id); }
  items = items.filter((it) => it.id !== id);
  render();
  toast("Removed");
}

async function toggleStar(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.starred = !it.starred;
  await dbPut(it);
  render();
}

function humanSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ---------------- 6. Rendering ---------------- */

const objectUrls = new Map();
function urlForBlob(item) {
  if (objectUrls.has(item.id)) return objectUrls.get(item.id);
  const url = URL.createObjectURL(item.blob);
  objectUrls.set(item.id, url);
  return url;
}

function viewItems() {
  let list = items.slice();
  if (activeView === "starred") list = list.filter((i) => i.starred);
  else if (activeView !== "all") list = list.filter((i) => bucketOf(i.category) === activeView);

  if (searchTerm) {
    list = list.filter((it) => {
      const hay = `${it.title} ${it.subtitle} ${it.url || ""} ${it.note || ""}`.toLowerCase();
      return hay.includes(searchTerm);
    });
  }

  list.sort((a, b) => {
    if (sortOrder === "az") return String(a.title).localeCompare(String(b.title));
    return sortOrder === "old" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  });
  return list;
}

function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  const tint = `thumb-tint-${bucketOf(item.category)}`;

  // Image previews (uploaded file or direct image link)
  if (item.category === "photo") {
    const src = item.kind === "file" ? urlForBlob(item) : (item.thumbnail || item.url);
    if (src) return `<div class="item-thumb">${starBtn(item)}<img loading="lazy" src="${esc(src)}" alt="${esc(item.title)}" /></div>`;
  }
  // Thumbnails (e.g. YouTube)
  if (item.thumbnail) {
    return `<div class="item-thumb">${starBtn(item)}
      <img loading="lazy" src="${esc(item.thumbnail)}" alt="${esc(item.title)}"
           onerror="this.remove()" /></div>`;
  }
  // Tinted icon tile
  return `<div class="item-thumb ${tint}">${starBtn(item)}
    <span class="type-tag">${ICONS[meta.icon]} ${meta.label}</span>
    <span class="thumb-ic ic">${ICONS[meta.icon]}</span></div>`;
}

function starBtn(item) {
  return `<button class="star-btn ${item.starred ? "starred" : ""}" data-star="${item.id}"
            title="${item.starred ? "Unstar" : "Star"}" aria-label="Star">${ICONS.star}</button>`;
}

function cardHtml(item) {
  // Note card
  if (item.category === "note") {
    return `<article class="item-card" data-id="${item.id}">
      ${starBtn(item)}
      <div class="item-note">${esc(item.note || item.title)}</div>
      <div class="item-actions">
        <button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button>
      </div>
    </article>`;
  }

  const open = item.kind === "file"
    ? `<a class="item-open" href="${esc(urlForBlob(item))}" target="_blank" rel="noopener" download="${esc(item.title)}">${ICONS.external} Open</a>`
    : item.url
      ? `<a class="item-open" href="${esc(item.url)}" target="_blank" rel="noopener">${ICONS.external} Open</a>`
      : "";

  return `<article class="item-card" data-id="${item.id}">
    ${thumbFor(item)}
    <div class="item-info">
      <h3 class="item-title">${esc(item.title)}</h3>
      <p class="item-sub">${esc(item.subtitle || item.url || "")}</p>
    </div>
    <div class="item-actions">
      ${open}
      <button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button>
    </div>
  </article>`;
}

function render() {
  // Sidebar counts
  const counts = { all: items.length, docs: 0, notes: 0, links: 0, images: 0, starred: 0 };
  items.forEach((it) => {
    counts[bucketOf(it.category)]++;
    if (it.starred) counts.starred++;
  });
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = counts[el.dataset.count] ?? 0;
  });

  const list = viewItems();
  countLabel.textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;

  grid.innerHTML = list.map(cardHtml).join("");

  // Empty state
  if (list.length === 0) {
    emptyState.style.display = "flex";
    if (items.length === 0) {
      emptyTitle.textContent = "Your workspace is empty";
      emptyText.innerHTML = 'Upload a <span class="link-accent">PDF</span> or image, jot a note, or save a link. You can also drop files anywhere on this page.';
    } else if (searchTerm) {
      emptyTitle.textContent = "No matches found";
      emptyText.textContent = "Try a different search, or clear it to see everything.";
    } else {
      emptyTitle.textContent = "Nothing here yet";
      emptyText.textContent = "This shelf is empty. Add something and it'll show up here.";
    }
  } else {
    emptyState.style.display = "none";
  }
}

/* ---------------- 7. Helpers ---------------- */

function esc(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ---------------- 8. Modal ---------------- */

function openModal() {
  modalOverlay.hidden = false;
  setTimeout(() => linkInput.focus(), 40);
}
function closeModal() {
  modalOverlay.hidden = true;
  linkInput.value = "";
}

/* ---------------- 9. Event wiring ---------------- */

// Add buttons open the modal
$("#addBtn").addEventListener("click", openModal);
$("#addFirstBtn").addEventListener("click", openModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modalCancel").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

// Submit link/note from modal
function submitLink() {
  if (linkInput.value.trim()) { addFromText(linkInput.value); closeModal(); }
}
$("#addLinkBtn").addEventListener("click", submitLink);
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLink(); });

// File picker (inside modal)
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; closeModal(); });

// Grid actions (delegation): open handled by anchor, delete + star here
grid.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { removeItem(del.getAttribute("data-del")); return; }
  const star = e.target.closest("[data-star]");
  if (star) { toggleStar(star.getAttribute("data-star")); }
});

// Sidebar navigation
nav.addEventListener("click", (e) => {
  const item = e.target.closest(".nav-item");
  if (!item) return;
  nav.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  item.classList.add("active");
  activeView = item.dataset.view;
  render();
});

// Sort
sortSelect.addEventListener("change", () => { sortOrder = sortSelect.value; render(); });

// Search
searchInput.addEventListener("input", () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });

// Sign out (no auth yet)
$("#logoutBtn").addEventListener("click", () => toast("You're all set — nothing to sign out of yet"));

// Keyboard shortcuts: Cmd/Ctrl+K = search, N = new, Esc = close modal
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault(); searchInput.focus(); searchInput.select();
  } else if (e.key === "Escape") {
    if (!modalOverlay.hidden) closeModal();
  } else if (e.key.toLowerCase() === "n" && !typing && modalOverlay.hidden) {
    e.preventDefault(); openModal();
  }
});

// Global drag & drop (drop files anywhere on the page)
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
    e.preventDefault(); dragDepth++; dropOverlay.classList.add("show");
  }
});
window.addEventListener("dragover", (e) => { if (dropOverlay.classList.contains("show")) e.preventDefault(); });
window.addEventListener("dragleave", (e) => {
  if (dropOverlay.classList.contains("show")) { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove("show"); } }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0; dropOverlay.classList.remove("show");
  const dt = e.dataTransfer;
  if (!dt) return;
  if (dt.files && dt.files.length) { addFiles(dt.files); return; }
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) addFromText(text);
});

/* ---------------- 10. Boot ---------------- */

(async function init() {
  injectIcons();
  if (sortSelect) sortSelect.value = sortOrder;
  try {
    items = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error("Failed to load from IndexedDB", err);
    items = [];
  }
  render();
})();
