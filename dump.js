/* ============================================================
   Dump — page 1 (staging), backed by the API
   Paste / drop / screenshot -> server classifies + OCRs ->
   review the 4 shelves -> approve -> library.
   Requires core.js + api.js
   ============================================================ */

let staged = [];   // items with approved === false (server-backed)
let busy = 0;      // in-flight server operations (classify/OCR)
let selectedReels = new Set();   // reel ids ticked for the batch "approve to a section" flow

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
  let dups = 0;
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
      if (item.duplicate) { dups++; continue; }
      staged.unshift(item);
      render();
    }
    if (dups) toast(dups === 1 ? "Already saved — skipped 1 duplicate" : `Skipped ${dups} duplicates`);
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
      if (!item.duplicate) { staged.unshift(item); render(); }
      if (item.ocrUrls && item.ocrUrls.length) foundUrls.push(...item.ocrUrls);
    }
    // Screenshots: turn any links the AI read out of the image into their own items.
    const known = new Set(staged.map((s) => s.url).filter(Boolean));
    const fresh = [...new Set(foundUrls)].filter((u) => !known.has(u));
    let added = 0;
    for (const url of fresh) {
      const info = detectLink(url);
      const link = await Items.create({
        kind: "link", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: info.subtitle || info.domain || "", url: info.url,
        thumbnail: info.thumbnail || null, approved: false,
      });
      if (link.duplicate) continue;
      staged.unshift(link); render(); added++;
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
async function togglePin(id) {
  const it = staged.find((s) => s.id === id); if (!it) return;
  it.pinned = !it.pinned;
  render();
  toast(it.pinned ? "Pinned" : "Unpinned");
  try { await Items.update(id, { pinned: it.pinned }); } catch (e) { toast(e.message); }
}

/* ---------------- Note modal ---------------- */
let editingNoteId = null;
const noteModal = $("#noteModal");
const noteInput = $("#noteInput");
const noteModalSub = $("#noteModalSub");
function openNoteModal(id) {
  const it = staged.find((s) => s.id === id); if (!it) return;
  editingNoteId = id;
  noteInput.value = it.annotation || "";
  noteModalSub.textContent = `Note for “${it.title}”`;
  noteModal.hidden = false;
  setTimeout(() => noteInput.focus(), 40);
}
function closeNoteModal() { noteModal.hidden = true; editingNoteId = null; }
async function saveNote(text) {
  const id = editingNoteId;
  const it = staged.find((s) => s.id === id);
  closeNoteModal();
  if (!it) return;
  it.annotation = text;
  render();
  try { await Items.update(id, { annotation: text }); } catch (e) { toast(e.message); }
  toast(text.trim() ? "Note saved" : "Note cleared");
}
async function approveAll() {
  const top = staged.filter((s) => !s.parentId);
  if (!top.length) return;
  const count = top.length;
  approveBtn.disabled = true;
  try { for (const it of staged) await Items.update(it.id, { approved: true }); } // approves reels + their attachments
  catch (e) { approveBtn.disabled = false; return toast(e.message); }
  staged = [];
  render();
  toast(`${count} item${count === 1 ? "" : "s"} sent to your library`);
}

/* ---------------- Rendering ---------------- */

function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  let overlay = "";
  if (item.hasCover) {
    overlay = `<img class="thumb-img" referrerpolicy="no-referrer" src="${esc(Items.coverUrl(item))}" onerror="this.remove()" alt="" />`;
  } else if (item.category === "photo") {
    const src = item.hasFile ? Items.fileUrl(item) : (item.thumbnail || item.url);
    if (src) overlay = `<img class="thumb-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(src)}" onerror="this.remove()" alt="" />`;
  } else if (item.category === "doc" && item.hasFile) {
    overlay = `<img class="thumb-img" data-pdf="${item.id}" data-pdf-url="${esc(Items.fileUrl(item))}" onerror="this.remove()" alt="" />`;
  } else if (item.thumbnail) {
    overlay = `<img class="thumb-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(item.thumbnail)}" onerror="this.remove()" alt="" />`;
  }
  const coverTitle = item.hasCover ? "Replace cover — click, then Ctrl+V" : "Add cover — click, then Ctrl+V";
  const armed = item.id === pendingCoverId;
  const wb = (item.category === "reel" || item.category === "video") ? `<button class="wb-btn" data-wb-open="${item.id}" title="Whiteboard thumbnail">${ICONS.type}</button>` : "";
  return `<div class="dcard-thumb ${overlay ? "" : "tinted"} ${armed ? "cover-armed" : ""}">${wb}<button class="cover-btn ${armed ? "armed" : ""}" data-cover="${item.id}" title="${coverTitle}">${ICONS.camera}</button><span class="thumb-ic ic">${ICONS[meta.icon]}</span>${overlay}${armed ? '<span class="cover-hint">Press Ctrl+V</span>' : ""}</div>`;
}

function sectionSelect(item) {
  return `<select class="dcard-select" data-move="${item.id}" title="Move to section">
    ${SECTIONS.map((s) => `<option value="${s}" ${s === item.section ? "selected" : ""}>${SECTION_META[s].label}</option>`).join("")}
  </select>`;
}
function pinBtn(item) {
  return `<button class="pin-btn ${item.pinned ? "pinned" : ""}" data-pin="${item.id}" title="${item.pinned ? "Unpin" : "Pin"}">${ICONS.pin}<span>${item.pinned ? "Pinned" : "Pin"}</span></button>`;
}
function noteBtn(item) {
  const has = item.annotation && item.annotation.trim();
  return `<button class="note-btn ${has ? "has-note" : ""}" data-note="${item.id}" title="${has ? "Edit your note" : "Add a note"}">${ICONS.notebook}<span>Note</span></button>`;
}
function noteSnippet(item) {
  const t = (item.annotation || "").trim();
  if (!t) return "";
  return `<p class="item-note-snippet"><span class="ic">${ICONS.notebook}</span>${esc(t)}</p>`;
}
function attachmentsOf(id) { return staged.filter((a) => a.parentId === id); }
function attachmentsHtml(item) {
  if (item.category !== "reel" && item.category !== "video") return "";
  const atts = attachmentsOf(item.id);
  const chips = atts.map((a) => {
    const meta = TYPE_META[a.category] || TYPE_META.link;
    return `<span class="att-chip" data-open-att="${a.id}" title="${esc(a.title)}">
      <span class="ic">${ICONS[meta.icon]}</span><span class="att-title">${esc(a.title)}</span>
      <button class="att-del" data-del="${a.id}" title="Remove attachment">${ICONS.x}</button>
    </span>`;
  }).join("");
  return `<div class="attachments">
    ${atts.length ? `<div class="att-list">${chips}</div>` : ""}
    <button class="att-add" data-attach="${item.id}"><span class="ic">${ICONS.plus}</span> Attach PDF, link or doc</button>
  </div>`;
}

function dumpCardHtml(item) {
  const isNote = item.category === "note";
  const body = isNote
    ? `<div class="dcard-note">${esc(item.note || item.title)}</div>`
    : `${thumbFor(item)}
       <div class="dcard-info">
         <p class="dcard-title">${esc(item.title)}</p>
         <p class="dcard-sub">${esc(item.subtitle || item.url || "")}</p>
         ${noteSnippet(item)}
       </div>`;
  const openable = (item.hasFile || item.url) ? "is-openable" : "";
  const inReels = item.section === "reels" && !item.parentId;
  const selected = inReels && selectedReels.has(item.id);
  const selectBox = inReels
    ? `<label class="dcard-check" title="Select this reel to approve"><input type="checkbox" data-select="${item.id}" ${selected ? "checked" : ""} /></label>`
    : "";
  return `<article class="dcard ${openable} ${selected ? "selected" : ""}" data-id="${item.id}">
    <div class="dcard-top">${selectBox}<button class="dcard-del" data-del="${item.id}" title="Discard">${ICONS.x}</button></div>
    ${body}
    <div class="dcard-foot">
      <div class="dcard-controls">${pinBtn(item)}${noteBtn(item)}</div>
      ${sectionSelect(item)}
    </div>
    ${attachmentsHtml(item)}
  </article>`;
}

function render() {
  const counts = { reels: 0, pdfs: 0, links: 0, screenshots: 0 };
  SECTIONS.forEach((sec) => {
    const bodyEl = document.querySelector(`[data-body="${sec}"]`);
    const list = staged.filter((it) => !it.parentId && it.section === sec); // attachments nest inside their reel
    counts[sec] = list.length;
    bodyEl.innerHTML = list.length ? list.map(dumpCardHtml).join("") : `<div class="section-empty">Nothing here yet</div>`;
  });
  document.querySelectorAll("[data-scount]").forEach((el) => { el.textContent = counts[el.dataset.scount]; });
  hydratePdfThumbs(document.getElementById("sections"));
  const topCount = staged.filter((s) => !s.parentId).length;
  approveCount.textContent = topCount;
  approveBtn.disabled = topCount === 0 || busy > 0;
  updateReelSelBar();
  updateStatus();
}

function updateStatus() {
  if (!Auth.isLoggedIn()) {
    stagingStatus.innerHTML = 'Sign in to start dumping — <a class="link-accent" href="signin.html">sign in</a> or <a class="link-accent" href="signup.html">create an account</a>.';
    return;
  }
  if (busy > 0) { stagingStatus.innerHTML = `<span class="dot-pulse"></span> AI is reading &amp; sorting…`; return; }
  if (!staged.some((s) => !s.parentId)) { stagingStatus.textContent = "Nothing dumped yet — paste a link or screenshot above."; return; }
  stagingStatus.textContent = `Sorted into ${SECTIONS.length} shelves · review and approve to send to your library.`;
}

/* ---------------- Reels: tick-to-select + approve into a section ---------------- */
const reelSecModal = $("#reelSectionModal");
const reelSecList = $("#reelSecList");
const reelSecNewWrap = $("#reelSecNewWrap");
const reelSecNewInput = $("#reelSecNewInput");
const reelSecConfirm = $("#reelSecConfirm");
const reelSecSub = $("#reelSecSub");
let reelSections = [];        // the user's created sections (loaded when the modal opens)
let chosenSectionId = null;   // an existing section picked in the modal
let creatingNew = false;      // is the "new section" input showing?

function reelsInShelf() { return staged.filter((s) => !s.parentId && s.section === "reels"); }

// Show/refresh the "Select all · Approve N" bar above the reels shelf.
function updateReelSelBar() {
  const bar = document.getElementById("reelsSelBar");
  if (!bar) return;
  const reels = reelsInShelf();
  for (const id of [...selectedReels]) if (!reels.some((r) => r.id === id)) selectedReels.delete(id); // prune gone reels
  bar.hidden = reels.length === 0;
  const n = selectedReels.size;
  const cnt = document.getElementById("reelsSelCount"); if (cnt) cnt.textContent = n;
  const btn = document.getElementById("approveReelsBtn"); if (btn) btn.disabled = n === 0 || busy > 0;
  const all = document.getElementById("reelsSelectAll");
  if (all) { all.checked = reels.length > 0 && n === reels.length; all.indeterminate = n > 0 && n < reels.length; }
}

function toggleReelSelect(id, checked) {
  if (checked) selectedReels.add(id); else selectedReels.delete(id);
  const card = document.querySelector(`.dcard[data-id="${id}"]`);
  if (card) card.classList.toggle("selected", checked);
  updateReelSelBar();
}

function updateReelSecConfirm() {
  reelSecConfirm.disabled = !(chosenSectionId || (creatingNew && reelSecNewInput.value.trim()));
}

function renderReelSecList() {
  const opts = reelSections.map((s) =>
    `<button type="button" class="reel-sec-opt ${chosenSectionId === s.id ? "active" : ""}" data-secpick="${s.id}">
       <span class="ic">${ICONS.folder}</span>
       <span class="reel-sec-name">${esc(s.name)}</span>
       <span class="reel-sec-count">${s.count}</span>
     </button>`).join("");
  const empty = reelSections.length ? "" : `<p class="reel-sec-empty">You don't have any sections yet — create your first one below.</p>`;
  reelSecList.innerHTML = empty + opts +
    `<button type="button" class="reel-sec-newbtn ${creatingNew ? "active" : ""}" id="reelSecNewBtn"><span class="ic">${ICONS.plus}</span> Create new section</button>`;
}

async function openReelSectionModal() {
  if (!selectedReels.size) return;
  chosenSectionId = null; creatingNew = false;
  reelSecNewWrap.hidden = true; reelSecNewInput.value = "";
  reelSecConfirm.disabled = true;
  const n = selectedReels.size;
  reelSecSub.textContent = `Move the ${n} selected reel${n === 1 ? "" : "s"} into one of your sections.`;
  reelSecList.innerHTML = `<p class="reel-sec-empty">Loading your sections…</p>`;
  reelSecModal.hidden = false;
  try { reelSections = await Sections.list(); }
  catch (e) { reelSections = []; toast(e.message); }
  renderReelSecList();
}

function closeReelSectionModal() { reelSecModal.hidden = true; }

async function approveSelectedReels(sectionId, sectionName) {
  const ids = [...selectedReels];
  if (!ids.length || !sectionId) return;
  reelSecConfirm.disabled = true;
  try {
    for (const id of ids) {
      await Items.update(id, { approved: true, section_id: sectionId });
      // attachments live with their reel — approve + file them alongside it
      for (const att of staged.filter((a) => a.parentId === id)) {
        await Items.update(att.id, { approved: true, section_id: sectionId });
      }
    }
  } catch (e) { reelSecConfirm.disabled = false; return toast(e.message); }
  const idSet = new Set(ids);
  staged = staged.filter((s) => !idSet.has(s.id) && !idSet.has(s.parentId));
  selectedReels.clear();
  closeReelSectionModal();
  render();
  toast(`Moved ${ids.length} reel${ids.length === 1 ? "" : "s"} → ${sectionName || "your section"}`);
}

/* ---------------- Custom cover image (paste a screenshot or browse) ---------------- */
let pendingCoverId = null;
const coverInput = $("#coverInput");
function pickCover(id) {
  if (pendingCoverId === id) { coverInput.value = ""; coverInput.click(); return; } // second click -> browse
  pendingCoverId = id;
  render();
  toast("Ready — press Ctrl/⌘+V to paste your screenshot (or click again to browse)");
}
function clearArmed() { if (pendingCoverId) { pendingCoverId = null; render(); } }
async function applyCover(id, file) {
  toast("Uploading cover…");
  try {
    const updated = await Items.setCover(id, file);
    const it = staged.find((s) => s.id === id);
    if (it) { it.hasCover = true; it.coverUrl = updated.coverUrl; }
    render();
    toast("Cover updated");
  } catch (e) { toast(e.message); }
}
if (coverInput) coverInput.addEventListener("change", () => {
  const file = coverInput.files && coverInput.files[0];
  const id = pendingCoverId; coverInput.value = ""; clearArmed();
  if (file && id) applyCover(id, file);
});

/* ---------------- Attach modal (attach items to a reel) ---------------- */
let attachTargetId = null;
const attachModal = $("#attachModal");
const attachLinkInput = $("#attachLinkInput");
const attachFileInput = $("#attachFileInput");
const attachModalSub = $("#attachModalSub");
function openAttachModal(reelId) {
  const it = staged.find((s) => s.id === reelId); if (!it) return;
  attachTargetId = reelId; attachLinkInput.value = "";
  attachModalSub.textContent = `Attach to “${it.title}”`;
  attachModal.hidden = false; setTimeout(() => attachLinkInput.focus(), 40);
}
function closeAttachModal() { attachModal.hidden = true; attachTargetId = null; }
async function attachLink(raw) {
  const reelId = attachTargetId;
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!reelId || !parts.length) return;
  let added = 0, dups = 0;
  for (const part of parts) {
    const info = detectLink(part);
    try {
      const item = await Items.create({
        kind: info.url ? "link" : "note", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: info.subtitle || info.domain || "", url: info.url,
        note: info.category === "note" ? info.title : null, thumbnail: info.thumbnail || null,
        approved: false, analyze: false, parent_id: reelId,
      });
      if (item.duplicate) { dups++; continue; }
      staged.push(item); added++;
    } catch (e) { return toast(e.message); }
  }
  render();
  if (added) toast(added > 1 ? `Attached ${added} items` : "Attached");
  else if (dups) toast("Already attached");
}
async function attachFiles(fileList) {
  const reelId = attachTargetId;
  const files = Array.from(fileList);
  if (!reelId || !files.length) return;
  for (const file of files) {
    const info = detectFile(file);
    try {
      const payload = await Items.fileToPayload(file, {
        kind: "file", category: info.category, section: sectionOf(info.category),
        title: info.title, subtitle: humanSize(file.size), approved: false, analyze: false, parent_id: reelId,
      });
      staged.push(await Items.create(payload));
    } catch (e) { return toast(e.message); }
  }
  render();
  toast(files.length > 1 ? `Attached ${files.length} files` : "File attached");
}
function submitAttach() { if (attachLinkInput.value.trim()) { attachLink(attachLinkInput.value); closeAttachModal(); } }

/* ---------------- Whiteboard thumbnail (reels) ---------------- */
let wbTargetId = null, wbTheme = WB_THEMES[0];
const wbModal = $("#wbModal");
const wbCanvas = $("#wbCanvas");
const wbText = $("#wbText");
const wbSwatches = $("#wbSwatches");
function wbBuildSwatches() {
  wbSwatches.innerHTML = WB_THEMES.map((t, i) =>
    `<button class="wb-swatch ${t === wbTheme ? "active" : ""}" data-wb="${i}" style="background:${t.bg};color:${t.fg}">Aa</button>`).join("");
}
function wbRefresh() { renderWhiteboard(wbCanvas, wbText.value, wbTheme); }
function openWhiteboard(id) {
  wbTargetId = id; wbText.value = ""; wbTheme = WB_THEMES[0];
  wbBuildSwatches(); wbModal.hidden = false; wbRefresh();
  setTimeout(() => wbText.focus(), 40);
}
function closeWhiteboard() { wbModal.hidden = true; wbTargetId = null; }
wbText.addEventListener("input", wbRefresh);
wbSwatches.addEventListener("click", (e) => { const b = e.target.closest("[data-wb]"); if (!b) return; wbTheme = WB_THEMES[+b.dataset.wb]; wbBuildSwatches(); wbRefresh(); });
$("#wbClose").addEventListener("click", closeWhiteboard);
$("#wbCancel").addEventListener("click", closeWhiteboard);
wbModal.addEventListener("click", (e) => { if (e.target === wbModal) closeWhiteboard(); });
$("#wbApply").addEventListener("click", async () => {
  const id = wbTargetId;
  if (!id) return;
  if (!wbText.value.trim()) { toast("Write some text first"); return; }
  const blob = await whiteboardBlob(wbCanvas);
  const file = new File([blob], "whiteboard.png", { type: "image/png" });
  closeWhiteboard();
  toast("Setting thumbnail…");
  try {
    const updated = await Items.setCover(id, file);
    const it = staged.find((s) => s.id === id);
    if (it) { it.hasCover = true; it.coverUrl = updated.coverUrl; }
    render();
    toast("Thumbnail set");
  } catch (e) { toast(e.message); }
});

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

// Reels: select-all + "approve selected → section"
const reelsSelectAll = $("#reelsSelectAll");
if (reelsSelectAll) reelsSelectAll.addEventListener("change", (e) => {
  const reels = reelsInShelf();
  if (e.target.checked) reels.forEach((r) => selectedReels.add(r.id));
  else selectedReels.clear();
  render();
});
const approveReelsBtn = $("#approveReelsBtn");
if (approveReelsBtn) approveReelsBtn.addEventListener("click", openReelSectionModal);

// Reel → section picker modal
$("#reelSecClose").addEventListener("click", closeReelSectionModal);
$("#reelSecCancel").addEventListener("click", closeReelSectionModal);
reelSecModal.addEventListener("click", (e) => { if (e.target === reelSecModal) closeReelSectionModal(); });
reelSecList.addEventListener("click", (e) => {
  const pick = e.target.closest("[data-secpick]");
  if (pick) { chosenSectionId = pick.getAttribute("data-secpick"); creatingNew = false; reelSecNewWrap.hidden = true; renderReelSecList(); updateReelSecConfirm(); return; }
  if (e.target.closest("#reelSecNewBtn")) { creatingNew = true; chosenSectionId = null; reelSecNewWrap.hidden = false; renderReelSecList(); reelSecNewInput.focus(); updateReelSecConfirm(); }
});
reelSecNewInput.addEventListener("input", () => { creatingNew = true; chosenSectionId = null; updateReelSecConfirm(); });
reelSecNewInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !reelSecConfirm.disabled) reelSecConfirm.click(); });
reelSecConfirm.addEventListener("click", async () => {
  if (creatingNew && reelSecNewInput.value.trim()) {
    let sec;
    try { sec = await Sections.create(reelSecNewInput.value.trim()); }
    catch (e) { return toast(e.message); }
    reelSections.push(sec);
    return approveSelectedReels(sec.id, sec.name);
  }
  if (chosenSectionId) {
    const sec = reelSections.find((s) => s.id === chosenSectionId);
    return approveSelectedReels(chosenSectionId, sec && sec.name);
  }
});

// Note modal
$("#noteModalClose").addEventListener("click", closeNoteModal);
$("#noteSave").addEventListener("click", () => saveNote(noteInput.value));
$("#noteClear").addEventListener("click", () => saveNote(""));
noteModal.addEventListener("click", (e) => { if (e.target === noteModal) closeNoteModal(); });

// Attach modal
$("#attachModalClose").addEventListener("click", closeAttachModal);
$("#attachCancel").addEventListener("click", closeAttachModal);
$("#attachSubmit").addEventListener("click", submitAttach);
attachLinkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAttach(); });
attachFileInput.addEventListener("change", () => { attachFiles(attachFileInput.files); attachFileInput.value = ""; closeAttachModal(); });
attachModal.addEventListener("click", (e) => { if (e.target === attachModal) closeAttachModal(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!reelSecModal.hidden) closeReelSectionModal(); else if (!wbModal.hidden) closeWhiteboard(); else if (!attachModal.hidden) closeAttachModal(); else if (!noteModal.hidden) closeNoteModal(); else if (pendingCoverId) clearArmed(); }
});

$("#sections").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { removeStaged(del.getAttribute("data-del")); return; }
  const pin = e.target.closest("[data-pin]"); if (pin) return togglePin(pin.getAttribute("data-pin"));
  const note = e.target.closest("[data-note]"); if (note) return openNoteModal(note.getAttribute("data-note"));
  const cover = e.target.closest("[data-cover]"); if (cover) return pickCover(cover.getAttribute("data-cover"));
  const attach = e.target.closest("[data-attach]"); if (attach) return openAttachModal(attach.getAttribute("data-attach"));
  const wbOpen = e.target.closest("[data-wb-open]"); if (wbOpen) return openWhiteboard(wbOpen.getAttribute("data-wb-open"));
  const openAtt = e.target.closest("[data-open-att]");
  if (openAtt) { const a = staged.find((s) => s.id === openAtt.getAttribute("data-open-att")); if (a) { const href = a.hasFile ? Items.fileUrl(a) : canonicalGoogleUrl(a.url); if (href) window.open(href, "_blank", "noopener"); } return; }
  const card = e.target.closest(".dcard.is-openable");
  if (card && !e.target.closest("button, select, .attachments, .dcard-check")) {
    const it = staged.find((s) => s.id === card.dataset.id);
    if (it) { const href = it.hasFile ? Items.fileUrl(it) : canonicalGoogleUrl(it.url); if (href) window.open(href, "_blank", "noopener"); }
  }
});
$("#sections").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) { toggleReelSelect(sel.getAttribute("data-select"), sel.checked); return; }
  const mv = e.target.closest("[data-move]");
  if (mv) moveStaged(mv.getAttribute("data-move"), mv.value);
});

// Paste a screenshot from the clipboard (Ctrl/⌘+V):
//  - if a card is armed for a cover -> set it as that card's cover
//  - otherwise -> dump it as a new item
window.addEventListener("paste", (e) => {
  const imgs = clipboardImageFiles(e);
  if (!imgs.length) return;
  e.preventDefault();
  if (pendingCoverId) { const id = pendingCoverId; clearArmed(); applyCover(id, imgs[0]); return; }
  dumpFiles(imgs);
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
    try {
      const removed = await Items.dedupe();
      staged = await Items.list({ approved: false });
      if (removed) toast(`Removed ${removed} duplicate${removed === 1 ? "" : "s"}`);
    } catch (e) { staged = []; if (!Auth.isLoggedIn()) setupAuthLink(); else toast(e.message); }
    if (linkInput) linkInput.focus();
  }
  render();
})();
