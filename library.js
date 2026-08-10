/* ============================================================
   Dump — page 2 (library)
   Shows approved items in a calm, sortable workspace.
   Requires core.js
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

/* ---------------- Adding (direct to library, pre-approved) ---------------- */

async function addFromText(raw) {
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  let added = 0, lastCat = null;
  for (const part of parts) {
    const info = detectLink(part);
    const item = {
      id: uid(), createdAt: Date.now() + added, kind: info.url ? "link" : "note",
      category: info.category, title: info.title, subtitle: info.subtitle || info.domain || "",
      url: info.url, thumbnail: info.thumbnail || null,
      note: info.category === "note" ? info.title : null,
      section: sectionOf(info.category), approved: true, starred: false,
    };
    await dbPut(item); items.unshift(item); lastCat = info.category; added++;
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
      id: uid(), createdAt: Date.now(), kind: "file", category: info.category,
      title: info.title, subtitle: humanSize(file.size), url: null, blob: file,
      mime: file.type, thumbnail: null, section: sectionOf(info.category),
      approved: true, starred: false,
    };
    await dbPut(item); items.unshift(item);
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
    const src = item.kind === "file" ? urlForBlob(item) : (item.thumbnail || item.url);
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
  const open = item.kind === "file"
    ? `<a class="item-open" href="${esc(urlForBlob(item))}" target="_blank" rel="noopener" download="${esc(item.title)}">${ICONS.external} Open</a>`
    : item.url ? `<a class="item-open" href="${esc(item.url)}" target="_blank" rel="noopener">${ICONS.external} Open</a>` : "";
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
$("#logoutBtn").addEventListener("click", () => {
  if (typeof isLoggedIn === "function" && isLoggedIn()) {
    logout();
    toast("Signed out");
    setTimeout(() => (location.href = "signin.html"), 500);
  } else {
    location.href = "signin.html";
  }
});

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
  injectIcons();
  if (sortSelect) sortSelect.value = sortOrder;
  try {
    items = (await dbAll())
      .filter((it) => it.approved !== false)   // approved (true or legacy undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error("Failed to load library", err);
    items = [];
  }
  render();
})();
