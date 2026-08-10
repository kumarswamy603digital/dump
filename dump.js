/* ============================================================
   Dump — page 1 (staging), backed by the API
   Paste / drop / screenshot -> server classifies + OCRs ->
   review the 4 shelves -> approve -> library.
   Requires core.js + api.js
   ============================================================ */

let staged = [];   // items with approved === false (server-backed)
let busy = 0;      // in-flight server operations (classify/OCR)

const $ = (s) => document.querySelector(s);
const fileInput = $("#fileInput");
const folderInput = $("#folderInput");
const linkInput = $("#linkInput");
const dropOverlay = $("#dropOverlay");
const stagingStatus = $("#stagingStatus");
const approveBtn = $("#approveBtn");
const approveCount = $("#approveCount");

/* ---------------- Auth gate ---------------- */
function requireLogin() {
  if (Auth.isLoggedIn()) return true;
  toast("Please sign in to start dumping");
  setTimeout(() => (location.href = "signin.html"), 600);
  return false;
}

/* ---------------- Adding to the dump ---------------- */

async function dumpText(raw) {
  if (!requireLogin()) return;
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  busy++; updateStatus();
  try {
    for (const part of parts) {
      const info = detectLink(part);
      const item = await Items.create({
        kind: info.url ? "link" : "note",
        category: info.category,
        section: sectionOf(info.category),
        title: info.title,
        subtitle: info.subtitle || info.domain || "",
        url: info.url,
        note: info.category === "note" ? info.title : null,
        thumbnail: info.thumbnail || null,
        approved: false,
      });
      staged.unshift(item);
      render();
    }
  } catch (e) { toast(e.message); }
  finally { busy = Math.max(0, busy - 1); render(); }
}

async function dumpFiles(fileList) {
  if (!requireLogin()) return;
  const files = Array.from(fileList);
  if (!files.length) return;
  busy++; updateStatus();
  const foundUrls = [];
  try {
    for (const file of files) {
      const info = detectFile(file);
      const payload = await Items.fileToPayload(file, {
        kind: "file",
        category: info.category,
        section: sectionOf(info.category),
        title: info.title,
        subtitle: humanSize(file.size),
        approved: false,
      });
      const item = await Items.create(payload);
      staged.unshift(item);
      render();
      if (item.ocrUrls && item.ocrUrls.length) foundUrls.push(...item.ocrUrls);
    }
    // Screenshots: turn any links the AI read out of the image into their own items.
    const known = new Set(staged.map((s) => s.url).filter(Boolean));
    const fresh = [...new Set(foundUrls)].filter((u) => !known.has(u));
    for (const url of fresh) {
      const info = detectLink(url);
      const link = await Items.create({
        kind: "link", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: info.subtitle || info.domain || "", url: info.url,
        thumbnail: info.thumbnail || null, approved: false,
      });
      staged.unshift(link);
      render();
    }
    if (fresh.length) toast(`Found ${fresh.length} link${fresh.length === 1 ? "" : "s"} in your screenshot`);
  } catch (e) { toast(e.message); }
  finally { busy = Math.max(0, busy - 1); render(); }
}

/* ---------------- Mutations ---------------- */

async function removeStaged(id) {
  try { await Items.remove(id); } catch (e) { return toast(e.message); }
  staged = staged.filter((s) => s.id !== id);
  render();
}
async function moveStaged(id, section) {
  const it = staged.find((s) => s.id === id);
  if (!it || !SECTIONS.includes(section)) return;
  it.section = section;
  render();
  try { await Items.update(id, { section }); } catch (e) { toast(e.message); }
}
async function approveAll() {
  if (!staged.length) return;
  const count = staged.length;
  approveBtn.disabled = true;
  try { for (const it of staged) await Items.update(it.id, { approved: true }); }
  catch (e) { approveBtn.disabled = false; return toast(e.message); }
  staged = [];
  render();
  toast(`${count} item${count === 1 ? "" : "s"} sent to your library`);
}

/* ---------------- Rendering ---------------- */

function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  let overlay = "";
  if (item.category === "photo") {
    const src = item.hasFile ? Items.fileUrl(item) : (item.thumbnail || item.url);
    if (src) overlay = `<img class="thumb-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(src)}" onerror="this.remove()" alt="" />`;
  } else if (item.category === "doc" && item.hasFile) {
    overlay = `<img class="thumb-img" data-pdf="${item.id}" data-pdf-url="${esc(Items.fileUrl(item))}" onerror="this.remove()" alt="" />`;
  } else if (item.thumbnail) {
    overlay = `<img class="thumb-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(item.thumbnail)}" onerror="this.remove()" alt="" />`;
  }
  return `<div class="dcard-thumb ${overlay ? "" : "tinted"}"><span class="thumb-ic ic">${ICONS[meta.icon]}</span>${overlay}</div>`;
}

function sectionSelect(item) {
  return `<select class="dcard-select" data-move="${item.id}" title="Move to section">
    ${SECTIONS.map((s) => `<option value="${s}" ${s === item.section ? "selected" : ""}>${SECTION_META[s].label}</option>`).join("")}
  </select>`;
}

function dumpCardHtml(item) {
  const isNote = item.category === "note";
  const body = isNote
    ? `<div class="dcard-note">${esc(item.note || item.title)}</div>`
    : `${thumbFor(item)}
       <div class="dcard-info">
         <p class="dcard-title">${esc(item.title)}</p>
         <p class="dcard-sub">${esc(item.subtitle || item.url || "")}</p>
       </div>`;
  const openable = (item.hasFile || item.url) ? "is-openable" : "";
  return `<article class="dcard ${openable}" data-id="${item.id}">
    <div class="dcard-top"><button class="dcard-del" data-del="${item.id}" title="Discard">${ICONS.x}</button></div>
    ${body}
    <div class="dcard-foot">${sectionSelect(item)}</div>
  </article>`;
}

function render() {
  const counts = { reels: 0, pdfs: 0, links: 0, screenshots: 0 };
  SECTIONS.forEach((sec) => {
    const bodyEl = document.querySelector(`[data-body="${sec}"]`);
    const list = staged.filter((it) => it.section === sec);
    counts[sec] = list.length;
    bodyEl.innerHTML = list.length ? list.map(dumpCardHtml).join("") : `<div class="section-empty">Nothing here yet</div>`;
  });
  document.querySelectorAll("[data-scount]").forEach((el) => { el.textContent = counts[el.dataset.scount]; });
  hydratePdfThumbs(document.getElementById("sections"));
  approveCount.textContent = staged.length;
  approveBtn.disabled = staged.length === 0 || busy > 0;
  updateStatus();
}

function updateStatus() {
  if (!Auth.isLoggedIn()) {
    stagingStatus.innerHTML = 'Sign in to start dumping — <a class="link-accent" href="signin.html">sign in</a> or <a class="link-accent" href="signup.html">create an account</a>.';
    return;
  }
  if (busy > 0) { stagingStatus.innerHTML = `<span class="dot-pulse"></span> AI is reading &amp; sorting…`; return; }
  if (!staged.length) { stagingStatus.textContent = "Nothing dumped yet — paste a link or screenshot above."; return; }
  stagingStatus.textContent = `Sorted into ${SECTIONS.length} shelves · review and approve to send to your library.`;
}

/* ---------------- Auth link in nav ---------------- */
function setupAuthLink() {
  const wrap = document.getElementById("authArea");
  if (!wrap) return;
  if (Auth.isLoggedIn()) {
    const name = esc(Auth.firstName());
    wrap.innerHTML = `
      <a class="nav-greet" href="profile.html" title="Your profile">Hi, ${name}</a>
      <a class="btn btn-primary btn-sm" href="app.html">Open library <span class="ic">${ICONS["arrow-right"]}</span></a>
      <a class="text-link" href="#" id="signOutLink">Sign out</a>`;
    document.getElementById("signOutLink").addEventListener("click", (e) => {
      e.preventDefault(); Auth.logout(); toast("Signed out"); setTimeout(() => location.reload(), 500);
    });
  } else {
    wrap.innerHTML = `
      <a class="text-link" href="signin.html">Sign in</a>
      <a class="btn btn-primary btn-sm" href="signup.html">Sign up</a>`;
  }
}

/* ---------------- Wiring ---------------- */

$("#addLinkBtn").addEventListener("click", () => { if (linkInput.value.trim()) { dumpText(linkInput.value); linkInput.value = ""; } });
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && linkInput.value.trim()) { dumpText(linkInput.value); linkInput.value = ""; } });
fileInput.addEventListener("change", () => { dumpFiles(fileInput.files); fileInput.value = ""; });
if (folderInput) folderInput.addEventListener("change", () => { dumpFiles(folderInput.files); folderInput.value = ""; });
approveBtn.addEventListener("click", approveAll);

$("#sections").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { removeStaged(del.getAttribute("data-del")); return; }
  const card = e.target.closest(".dcard.is-openable");
  if (card && !e.target.closest("button, select")) {
    const it = staged.find((s) => s.id === card.dataset.id);
    if (it) { const href = it.hasFile ? Items.fileUrl(it) : it.url; if (href) window.open(href, "_blank", "noopener"); }
  }
});
$("#sections").addEventListener("change", (e) => {
  const mv = e.target.closest("[data-move]");
  if (mv) moveStaged(mv.getAttribute("data-move"), mv.value);
});

// Paste a screenshot straight from the clipboard (Ctrl/⌘+V).
window.addEventListener("paste", (e) => {
  const imgs = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
  if (imgs.length) { e.preventDefault(); dumpFiles(imgs); }
});

// Global drag & drop (anywhere on the page).
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); dragDepth++; dropOverlay.classList.add("show"); } });
window.addEventListener("dragover", (e) => { if (dropOverlay.classList.contains("show")) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (dropOverlay.classList.contains("show")) { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove("show"); } } });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove("show");
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length) { dumpFiles(dt.files); return; }
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) dumpText(text);
});

/* ---------------- Boot ---------------- */

(async function init() {
  injectIcons();
  setupAuthLink();
  if (Auth.isLoggedIn()) {
    try { staged = await Items.list({ approved: false }); }
    catch (e) { staged = []; if (!Auth.isLoggedIn()) setupAuthLink(); else toast(e.message); }
    if (linkInput) linkInput.focus();
  }
  render();
})();
