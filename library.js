/* ============================================================
   Dump — page 2 (library), backed by the API
   Shows approved items. Requires sign-in.
   Requires core.js + api.js
   ============================================================ */

let items = [];
let activeView = "all";        // all | docs | notes | links | images | starred
let searchTerm = "";
let sortOrder = "new";

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
const nav = $("#nav");
const modalOverlay = $("#modalOverlay");
const dropOverlay = $("#dropOverlay");

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
      const item = await Items.create(payload);
      items.unshift(item);
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
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.starred = !it.starred;
  render();
  try { await Items.update(id, { starred: it.starred }); } catch (e) { toast(e.message); }
}

/* ---------------- Rendering ---------------- */

function viewItems() {
  let list = items.slice();
  if (activeView === "starred") list = list.filter((i) => i.starred);
  else if (activeView !== "all") list = list.filter((i) => bucketOf(i.category) === activeView);
  if (searchTerm) {
    list = list.filter((it) => `${it.title} ${it.subtitle} ${it.url || ""} ${it.note || ""}`.toLowerCase().includes(searchTerm));
  }
  list.sort((a, b) => {
    if (sortOrder === "az") return String(a.title).localeCompare(String(b.title));
    return sortOrder === "old" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  });
  return list;
}

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
  if (item.thumbnail) {
    return `<div class="item-thumb">${starBtn(item)}<img loading="lazy" src="${esc(item.thumbnail)}" alt="${esc(item.title)}" onerror="this.remove()" /></div>`;
  }
  return `<div class="item-thumb ${tint}">${starBtn(item)}<span class="type-tag">${ICONS[meta.icon]} ${meta.label}</span><span class="thumb-ic ic">${ICONS[meta.icon]}</span></div>`;
}

function cardHtml(item) {
  if (item.category === "note") {
    return `<article class="item-card" data-id="${item.id}">
      ${starBtn(item)}
      <div class="item-note">${esc(item.note || item.title)}</div>
      <div class="item-actions"><button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button></div>
    </article>`;
  }
  const href = item.hasFile ? Items.fileUrl(item) : item.url;
  const open = href
    ? `<a class="item-open" href="${esc(href)}" target="_blank" rel="noopener">${ICONS.external} Open</a>`
    : "";
  return `<article class="item-card" data-id="${item.id}">
    ${thumbFor(item)}
    <div class="item-info"><h3 class="item-title">${esc(item.title)}</h3><p class="item-sub">${esc(item.subtitle || item.url || "")}</p></div>
    <div class="item-actions">${open}<button class="item-del" data-del="${item.id}" title="Delete">${ICONS.trash}</button></div>
  </article>`;
}

function render() {
  const counts = { all: items.length, docs: 0, notes: 0, links: 0, images: 0, starred: 0 };
  items.forEach((it) => { counts[bucketOf(it.category)]++; if (it.starred) counts.starred++; });
  document.querySelectorAll("[data-count]").forEach((el) => { el.textContent = counts[el.dataset.count] ?? 0; });

  const list = viewItems();
  countLabel.textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  grid.innerHTML = list.map(cardHtml).join("");

  if (list.length === 0) {
    emptyState.style.display = "flex";
    if (items.length === 0) {
      emptyTitle.textContent = "Your library is empty";
      emptyText.innerHTML = 'Dump some links and files on the <a class="link-accent" href="index.html">home page</a>, approve them, and they\'ll appear here.';
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

/* ---------------- Modal ---------------- */

function openModal() { modalOverlay.hidden = false; setTimeout(() => linkInput.focus(), 40); }
function closeModal() { modalOverlay.hidden = true; linkInput.value = ""; }

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

grid.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { removeItem(del.getAttribute("data-del")); return; }
  const star = e.target.closest("[data-star]");
  if (star) toggleStar(star.getAttribute("data-star"));
});

nav.addEventListener("click", (e) => {
  const item = e.target.closest(".nav-item");
  if (!item) return;
  nav.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  item.classList.add("active");
  activeView = item.dataset.view;
  render();
});

sortSelect.addEventListener("change", () => { sortOrder = sortSelect.value; render(); });
searchInput.addEventListener("input", () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });
$("#logoutBtn").addEventListener("click", () => { Auth.logout(); toast("Signed out"); setTimeout(() => (location.href = "signin.html"), 400); });

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (e.key === "Escape") { if (!modalOverlay.hidden) closeModal(); }
  else if (e.key.toLowerCase() === "n" && !typing && modalOverlay.hidden) { e.preventDefault(); openModal(); }
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
  if (!Auth.isLoggedIn()) { location.replace("signin.html"); return; }
  injectIcons();
  if (sortSelect) sortSelect.value = sortOrder;
  // validate token; if invalid, bounce to sign-in
  const me = await Auth.refresh();
  if (!me) { location.replace("signin.html"); return; }
  try { items = await Items.list({ approved: true }); }
  catch (e) { items = []; toast(e.message); }
  render();
})();
