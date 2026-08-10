/* ============================================================
   Dump — page 2 (library), backed by the API
   Views: category filters, Starred, and the User Vault
   (Pinned grouped + custom Sections). Latest / After-one-month
   time filter. Requires sign-in.  Needs core.js + api.js
   ============================================================ */

const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;

let items = [];
let sections = [];
let activeView = "all";   // all|docs|notes|links|images|starred|pinned|sections|sec:<id>
let timeFilter = "latest"; // latest (<=30d) | older (>30d)
let searchTerm = "";
let sortOrder = "new";

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const vaultView = $("#vaultView");
const mainEl = $(".main");
const emptyState = $("#emptyState");
const emptyTitle = $("#emptyTitle");
const emptyText = $("#emptyText");
const countLabel = $("#countLabel");
const fileInput = $("#fileInput");
const linkInput = $("#linkInput");
const searchInput = $("#searchInput");
const sortSelect = $("#sortSelect");
const nav = $("#nav");
const navSections = $("#navSections");
const modalOverlay = $("#modalOverlay");
const dropOverlay = $("#dropOverlay");
const timeFilterEl = $("#timeFilter");
const sectionModal = $("#sectionModal");
const sectionNameInput = $("#sectionNameInput");
const sectionError = $("#sectionError");

/* ---------------- Adding (direct to library, approved) ---------------- */

async function addFromText(raw) {
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  let added = 0, lastCat = null;
  for (const part of parts) {
    const info = detectLink(part);
    try {
      const item = await Items.create({
        kind: info.url ? "link" : "note", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: info.subtitle || info.domain || "", url: info.url,
        note: info.category === "note" ? info.title : null, thumbnail: info.thumbnail || null,
        approved: true,
      });
      items.unshift(item); lastCat = info.category; added++;
    } catch (e) { return toast(e.message); }
  }
  render();
  toast(added > 1 ? `Added ${added} items` : `Saved to ${capitalize(bucketOf(lastCat))}`);
}

async function addFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    const info = detectFile(file);
    try {
      const payload = await Items.fileToPayload(file, {
        kind: "file", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: humanSize(file.size), approved: true,
      });
      items.unshift(await Items.create(payload));
    } catch (e) { return toast(e.message); }
  }
  render();
  toast(files.length > 1 ? `Uploaded ${files.length} files` : "File uploaded");
}

async function removeItem(id) {
  try { await Items.remove(id); } catch (e) { return toast(e.message); }
  items = items.filter((it) => it.id !== id);
  render();
  toast("Removed");
}
async function toggleStar(id) {
  const it = items.find((x) => x.id === id); if (!it) return;
  it.starred = !it.starred; render();
  try { await Items.update(id, { starred: it.starred }); } catch (e) { toast(e.message); }
}
async function togglePin(id) {
  const it = items.find((x) => x.id === id); if (!it) return;
  it.pinned = !it.pinned; render();
  toast(it.pinned ? "Pinned" : "Unpinned");
  try { await Items.update(id, { pinned: it.pinned }); } catch (e) { toast(e.message); }
}
async function assignSection(id, sectionId) {
  const it = items.find((x) => x.id === id); if (!it) return;
  it.sectionId = sectionId || null; render();
  try { await Items.update(id, { section_id: sectionId || null }); } catch (e) { toast(e.message); }
}

/* ---------------- Sections ---------------- */
async function reloadSections() { try { sections = await Sections.list(); } catch { sections = []; } }
function sectionCount(id) { return items.filter((i) => i.sectionId === id).length; }
function sectionName(id) { return (sections.find((s) => s.id === id) || {}).name || "Section"; }

async function createSection(name) {
  const s = await Sections.create(name);       // throws on error (caught by caller)
  sections.unshift(s);
}
async function deleteSection(id) {
  if (!confirm(`Delete the section "${sectionName(id)}"? Items stay in your library.`)) return;
  try { await Sections.remove(id); } catch (e) { return toast(e.message); }
  sections = sections.filter((s) => s.id !== id);
  items.forEach((i) => { if (i.sectionId === id) i.sectionId = null; });
  if (activeView === "sec:" + id) activeView = "sections";
  render();
  toast("Section deleted");
}

/* ---------------- Filtering ---------------- */
function inTime(it) {
  const age = Date.now() - it.createdAt;
  return timeFilter === "latest" ? age <= ONE_MONTH : age > ONE_MONTH;
}
function matchesSearch(it) {
  if (!searchTerm) return true;
  return `${it.title} ${it.subtitle} ${it.url || ""} ${it.note || ""}`.toLowerCase().includes(searchTerm);
}
function sortList(list) {
  return list.sort((a, b) => {
    if (sortOrder === "az") return String(a.title).localeCompare(String(b.title));
    return sortOrder === "old" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  });
}
function baseFor(view) {
  let list = items.slice();
  if (view === "starred") list = list.filter((i) => i.starred);
  else if (view === "pinned") list = list.filter((i) => i.pinned);
  else if (view.startsWith("sec:")) { const id = view.slice(4); list = list.filter((i) => i.sectionId === id); }
  else if (["docs", "notes", "links", "images"].includes(view)) list = list.filter((i) => bucketOf(i.category) === view);
  return list;
}
function visibleItems(view) {
  return sortList(baseFor(view).filter((i) => inTime(i) && matchesSearch(i)));
}

/* ---------------- Card rendering ---------------- */
function starBtn(item) {
  return `<button class="star-btn ${item.starred ? "starred" : ""}" data-star="${item.id}" title="${item.starred ? "Unstar" : "Star"}" aria-label="Star">${ICONS.star}</button>`;
}
function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  const tint = `thumb-tint-${bucketOf(item.category)}`;
  if (item.category === "photo") {
    const src = item.hasFile ? Items.fileUrl(item) : (item.thumbnail || item.url);
    if (src) return `<div class="item-thumb">${starBtn(item)}<img loading="lazy" src="${esc(src)}" alt="${esc(item.title)}" /></div>`;
  }
  if (item.thumbnail) return `<div class="item-thumb">${starBtn(item)}<img loading="lazy" src="${esc(item.thumbnail)}" alt="${esc(item.title)}" onerror="this.remove()" /></div>`;
  return `<div class="item-thumb ${tint}">${starBtn(item)}<span class="type-tag">${ICONS[meta.icon]} ${meta.label}</span><span class="thumb-ic ic">${ICONS[meta.icon]}</span></div>`;
}
function sectionSelect(item) {
  const opts = ['<option value="">No section</option>']
    .concat(sections.map((s) => `<option value="${s.id}" ${item.sectionId === s.id ? "selected" : ""}>${esc(s.name)}</option>`))
    .join("");
  return `<select class="sec-select" data-section="${item.id}" title="Assign to a section">${opts}</select>`;
}
function pinBtn(item) {
  return `<button class="pin-btn ${item.pinned ? "pinned" : ""}" data-pin="${item.id}" title="${item.pinned ? "Unpin" : "Pin"}">${ICONS.pin}<span>${item.pinned ? "Pinned" : "Pin"}</span></button>`;
}
function controlsRow(item) {
  return `<div class="item-controls">${pinBtn(item)}${sectionSelect(item)}</div>`;
}
function cardHtml(item) {
  if (item.category === "note") {
    return `<article class="item-card" data-id="${item.id}">
      ${starBtn(item)}
      <div class="item-note">${esc(item.note || item.title)}</div>
      <div class="item-actions"><button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button></div>
      ${controlsRow(item)}
    </article>`;
  }
  const href = item.hasFile ? Items.fileUrl(item) : item.url;
  const open = href ? `<a class="item-open" href="${esc(href)}" target="_blank" rel="noopener">${ICONS.external} Open</a>` : "";
  return `<article class="item-card" data-id="${item.id}">
    ${thumbFor(item)}
    <div class="item-info"><h3 class="item-title">${esc(item.title)}</h3><p class="item-sub">${esc(item.subtitle || item.url || "")}</p></div>
    <div class="item-actions">${open}<button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button></div>
    ${controlsRow(item)}
  </article>`;
}

/* ---------------- Views ---------------- */
function renderSidebarSections() {
  navSections.innerHTML = sections.map((s) => `
    <button class="nav-item nav-subitem ${activeView === "sec:" + s.id ? "active" : ""}" data-view="sec:${s.id}">
      <span class="ic" data-icon-inline>${ICONS.folder}</span>
      <span class="nav-label">${esc(s.name)}</span>
      <span class="nav-count">${sectionCount(s.id)}</span>
    </button>`).join("");
}

function renderPinned() {
  const list = visibleItems("pinned");
  const groups = { links: [], pdfs: [], images: [] };
  list.forEach((i) => { const b = bucketOf(i.category); groups[b === "docs" ? "pdfs" : b === "images" ? "images" : "links"].push(i); });
  const col = (title, icon, arr) => `
    <section class="pin-col">
      <div class="pin-col-head"><span class="ic">${ICONS[icon]}</span><h3>${title}</h3><span class="pin-col-count">${arr.length}</span></div>
      <div class="pin-col-body">${arr.length ? arr.map(cardHtml).join("") : `<div class="section-empty">Nothing pinned here yet</div>`}</div>
    </section>`;
  vaultView.innerHTML = `
    <p class="vault-note">Your pinned items, always one glance away.</p>
    <div class="pin-groups">
      ${col("Links", "link", groups.links)}
      ${col("PDFs & Docs", "file-text", groups.pdfs)}
      ${col("Images", "image", groups.images)}
    </div>`;
  countLabel.textContent = `${list.length} pinned`;
}

function renderSectionsManager() {
  const cards = sections.map((s) => `
    <article class="section-card" data-open-sec="${s.id}">
      <button class="section-card-del" data-del-sec="${s.id}" title="Delete section">${ICONS.trash}</button>
      <div class="section-card-ic ic">${ICONS.folder}</div>
      <h3 class="section-card-name">${esc(s.name)}</h3>
      <p class="section-card-count">${sectionCount(s.id)} item${sectionCount(s.id) === 1 ? "" : "s"}</p>
    </article>`).join("");
  vaultView.innerHTML = `
    <div class="sections-grid">
      ${cards}
      <button class="section-add-card" id="sectionAddCard"><span class="ic">${ICONS.plus}</span><span>New section</span></button>
    </div>`;
  countLabel.textContent = `${sections.length} section${sections.length === 1 ? "" : "s"}`;
}

function updateCounts() {
  const counts = { all: items.length, docs: 0, notes: 0, links: 0, images: 0, starred: 0, pinned: 0, sections: sections.length };
  items.forEach((it) => { counts[bucketOf(it.category)]++; if (it.starred) counts.starred++; if (it.pinned) counts.pinned++; });
  document.querySelectorAll("[data-count]").forEach((el) => { el.textContent = counts[el.dataset.count] ?? 0; });
}

function render() {
  updateCounts();
  renderSidebarSections();
  const isPinned = activeView === "pinned";
  const isSections = activeView === "sections";

  if (isPinned || isSections) {
    grid.style.display = "none";
    emptyState.style.display = "none";
    vaultView.hidden = false;
    if (isPinned) renderPinned(); else renderSectionsManager();
    return;
  }

  vaultView.hidden = true;
  grid.style.display = "";
  const list = visibleItems(activeView);
  const label = activeView.startsWith("sec:") ? ` in ${sectionName(activeView.slice(4))}` : "";
  countLabel.textContent = `${list.length} item${list.length === 1 ? "" : "s"}${label}`;
  grid.innerHTML = list.map(cardHtml).join("");

  if (list.length === 0) {
    emptyState.style.display = "flex";
    if (items.length === 0) {
      emptyTitle.textContent = "Your library is empty";
      emptyText.innerHTML = 'Dump some links and files on the <a class="link-accent" href="index.html">home page</a>, approve them, and they\'ll appear here.';
    } else if (searchTerm) {
      emptyTitle.textContent = "No matches found";
      emptyText.textContent = "Try a different search, or clear it to see everything.";
    } else if (timeFilter === "older") {
      emptyTitle.textContent = "Nothing older than a month";
      emptyText.textContent = "Items you saved more than 30 days ago will show up here.";
    } else {
      emptyTitle.textContent = "Nothing here yet";
      emptyText.textContent = "Nothing saved in the last month for this view.";
    }
  } else {
    emptyState.style.display = "none";
  }
}

/* ---------------- Add modal ---------------- */
function openModal() { modalOverlay.hidden = false; setTimeout(() => linkInput.focus(), 40); }
function closeModal() { modalOverlay.hidden = true; linkInput.value = ""; }

/* ---------------- Section modal ---------------- */
function openSectionModal() { sectionError.classList.remove("show"); sectionNameInput.value = ""; sectionModal.hidden = false; setTimeout(() => sectionNameInput.focus(), 40); }
function closeSectionModal() { sectionModal.hidden = true; }
async function submitSection() {
  const name = sectionNameInput.value.trim();
  if (!name) { sectionError.textContent = "Please enter a name."; sectionError.classList.add("show"); return; }
  try {
    await createSection(name);
    closeSectionModal();
    toast(`Section "${name}" created`);
    if (activeView === "sections") render(); else renderSidebarSections(), updateCounts();
  } catch (e) { sectionError.textContent = e.message; sectionError.classList.add("show"); }
}

/* ---------------- Wiring ---------------- */
$("#addBtn").addEventListener("click", openModal);
$("#addFirstBtn").addEventListener("click", openModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modalCancel").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
function submitLink() { if (linkInput.value.trim()) { addFromText(linkInput.value); closeModal(); } }
$("#addLinkBtn").addEventListener("click", submitLink);
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLink(); });
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; closeModal(); });

$("#newSectionBtn").addEventListener("click", openSectionModal);
$("#sectionModalClose").addEventListener("click", closeSectionModal);
$("#sectionCancel").addEventListener("click", closeSectionModal);
$("#sectionCreate").addEventListener("click", submitSection);
sectionNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitSection(); });
sectionModal.addEventListener("click", (e) => { if (e.target === sectionModal) closeSectionModal(); });

// Delegated interactions across grid + vault views
mainEl.addEventListener("click", (e) => {
  const delSec = e.target.closest("[data-del-sec]");
  if (delSec) { e.stopPropagation(); return deleteSection(delSec.getAttribute("data-del-sec")); }
  const openSec = e.target.closest("[data-open-sec]");
  if (openSec) { setView("sec:" + openSec.getAttribute("data-open-sec")); return; }
  if (e.target.closest("#sectionAddCard")) return openSectionModal();
  const del = e.target.closest("[data-del]"); if (del) return removeItem(del.getAttribute("data-del"));
  const star = e.target.closest("[data-star]"); if (star) return toggleStar(star.getAttribute("data-star"));
  const pin = e.target.closest("[data-pin]"); if (pin) return togglePin(pin.getAttribute("data-pin"));
});
mainEl.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-section]");
  if (sel) assignSection(sel.getAttribute("data-section"), sel.value);
});

// Sidebar navigation (static + dynamic sections)
function setView(view) {
  activeView = view;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  render();
}
nav.addEventListener("click", (e) => {
  const item = e.target.closest(".nav-item");
  if (item) setView(item.dataset.view);
});

// Time filter
timeFilterEl.addEventListener("click", (e) => {
  const seg = e.target.closest(".seg"); if (!seg) return;
  timeFilterEl.querySelectorAll(".seg").forEach((s) => s.classList.remove("active"));
  seg.classList.add("active");
  timeFilter = seg.dataset.time;
  render();
});

sortSelect.addEventListener("change", () => { sortOrder = sortSelect.value; render(); });
searchInput.addEventListener("input", () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });
$("#logoutBtn").addEventListener("click", () => { Auth.logout(); toast("Signed out"); setTimeout(() => (location.href = "signin.html"), 400); });

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (e.key === "Escape") { if (!modalOverlay.hidden) closeModal(); if (!sectionModal.hidden) closeSectionModal(); }
  else if (e.key.toLowerCase() === "n" && !typing && modalOverlay.hidden && sectionModal.hidden) { e.preventDefault(); openModal(); }
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); dragDepth++; dropOverlay.classList.add("show"); } });
window.addEventListener("dragover", (e) => { if (dropOverlay.classList.contains("show")) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (dropOverlay.classList.contains("show")) { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove("show"); } } });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove("show");
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length) { addFiles(dt.files); return; }
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) addFromText(text);
});

/* ---------------- Boot ---------------- */
(async function init() {
  // Trust the stored token — only bounce to sign-in when there's no session at all.
  if (!Auth.isLoggedIn()) { location.replace("signin.html"); return; }
  injectIcons();
  if (sortSelect) sortSelect.value = sortOrder;
  try {
    [items, sections] = await Promise.all([Items.list({ approved: true }), Sections.list()]);
  } catch (e) {
    // apiFetch clears the token on a 401 — if that happened, the session is truly invalid.
    if (!Auth.isLoggedIn()) { location.replace("signin.html"); return; }
    items = items || []; sections = sections || []; toast(e.message);
  }
  render();
})();
