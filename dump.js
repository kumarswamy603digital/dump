/* ============================================================
   Dump — page 1 (staging), backed by the API
   Dump -> classify into 4 sections -> approve -> library
   Requires core.js + api.js
   ============================================================ */

let staged = []; // items with approved === false (server-backed)

const $ = (s) => document.querySelector(s);
const fileInput = $("#fileInput");
const linkInput = $("#linkInput");
const dropzone = $("#dropzone");
const dropOverlay = $("#dropOverlay");
const stagingStatus = $("#stagingStatus");
const approveBtn = $("#approveBtn");
const approveCount = $("#approveCount");
let pendingAI = 0;

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
  const fresh = [];
  for (const part of parts) {
    const info = detectLink(part);
    try {
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
      item.aiState = hasGroq() ? "pending" : "rule";
      staged.unshift(item);
      fresh.push(item);
    } catch (e) { toast(e.message); return; }
  }
  render();
  classifyBatch(fresh);
}

async function dumpFiles(fileList) {
  if (!requireLogin()) return;
  const files = Array.from(fileList);
  if (!files.length) return;
  const fresh = [];
  for (const file of files) {
    const info = detectFile(file);
    try {
      const payload = await Items.fileToPayload(file, {
        kind: "file",
        category: info.category,
        section: sectionOf(info.category),
        title: info.title,
        subtitle: humanSize(file.size),
        approved: false,
      });
      const item = await Items.create(payload);
      item.blob = file; // keep in memory for AI vision classification
      item.aiState = hasGroq() && (file.type || "").startsWith("image/") ? "pending" : "rule";
      staged.unshift(item);
      fresh.push(item);
    } catch (e) { toast(e.message); return; }
  }
  render();
  classifyBatch(fresh);
}

/* ---------------- AI classification pass ---------------- */

async function classifyBatch(list) {
  if (!hasGroq()) return;
  const targets = list.filter((it) => it.aiState === "pending");
  if (!targets.length) return;
  pendingAI += targets.length;
  updateStatus();
  for (const item of targets) {
    const section = await aiClassify(item);
    const live = staged.find((s) => s.id === item.id);
    if (live) {
      if (section && SECTIONS.includes(section) && section !== live.section) {
        live.section = section;
        try { await Items.update(live.id, { section }); } catch {}
      }
      live.aiState = section ? "done" : "rule";
    }
    pendingAI = Math.max(0, pendingAI - 1);
    render();
  }
  updateStatus();
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
  it.section = section; it.aiState = "manual";
  render();
  try { await Items.update(id, { section }); } catch (e) { toast(e.message); }
}

async function approveAll() {
  if (!staged.length) return;
  const count = staged.length;
  approveBtn.disabled = true;
  try {
    for (const it of staged) await Items.update(it.id, { approved: true });
  } catch (e) { approveBtn.disabled = false; return toast(e.message); }
  staged = [];
  render();
  toast(`${count} item${count === 1 ? "" : "s"} sent to your library`);
}

/* ---------------- Rendering ---------------- */

function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  if (item.category === "photo") {
    const src = item.hasFile ? Items.fileUrl(item) : (item.thumbnail || item.url);
    if (src) return `<div class="dcard-thumb"><img loading="lazy" src="${esc(src)}" alt="${esc(item.title)}" /></div>`;
  }
  if (item.thumbnail) {
    return `<div class="dcard-thumb"><img loading="lazy" src="${esc(item.thumbnail)}" alt="${esc(item.title)}" onerror="this.remove()" /></div>`;
  }
  return `<div class="dcard-thumb tinted"><span class="thumb-ic ic">${ICONS[meta.icon]}</span></div>`;
}

function aiBadge(item) {
  if (item.aiState === "pending") return `<span class="ai-badge working"><span class="ic">${ICONS.sparkles}</span> AI…</span>`;
  if (item.aiState === "done") return `<span class="ai-badge done"><span class="ic">${ICONS.sparkles}</span> AI</span>`;
  if (item.aiState === "manual") return `<span class="ai-badge">edited</span>`;
  return "";
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
  return `<article class="dcard" data-id="${item.id}">
    <div class="dcard-top">${aiBadge(item)}<button class="dcard-del" data-del="${item.id}" title="Discard">${ICONS.x}</button></div>
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
  approveCount.textContent = staged.length;
  approveBtn.disabled = staged.length === 0;
  updateStatus();
}

function updateStatus() {
  if (!Auth.isLoggedIn()) { stagingStatus.innerHTML = 'Sign in to start dumping — <a class="link-accent" href="signin.html">sign in</a> or <a class="link-accent" href="signup.html">create an account</a>.'; return; }
  if (!staged.length) { stagingStatus.textContent = "Nothing dumped yet — drop something above."; return; }
  if (pendingAI > 0) {
    stagingStatus.innerHTML = `<span class="dot-pulse"></span> AI is sorting ${pendingAI} item${pendingAI === 1 ? "" : "s"}…`;
  } else {
    const how = hasGroq() ? "Sorted by AI" : "Sorted by built-in rules";
    stagingStatus.textContent = `${how} into ${SECTIONS.length} shelves · review and approve to send to your library.`;
  }
}

/* ---------------- AI settings modal ---------------- */

const aiModal = $("#aiModal");
const aiChip = $("#aiChip");
const aiChipLabel = $("#aiChipLabel");
const groqKeyInput = $("#groqKeyInput");

function refreshAiChip() {
  const on = hasGroq();
  aiChip.classList.toggle("on", on);
  aiChipLabel.textContent = on ? "AI: connected" : "AI: rule-based";
}
function openAiModal() { groqKeyInput.value = getGroqKey(); aiModal.hidden = false; setTimeout(() => groqKeyInput.focus(), 40); }
function closeAiModal() { aiModal.hidden = true; }

/* ---------------- Auth link in nav ---------------- */
function setupAuthLink() {
  const wrap = document.getElementById("authArea");
  if (!wrap) return;
  if (Auth.isLoggedIn()) {
    const name = esc(Auth.firstName());
    wrap.innerHTML = `
      <span class="nav-greet">Hi, ${name}</span>
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
dropzone.addEventListener("click", (e) => { if (!e.target.closest(".file-pick")) { if (requireLogin()) fileInput.click(); } });
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (requireLogin()) fileInput.click(); } });
approveBtn.addEventListener("click", approveAll);

$("#sections").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) removeStaged(del.getAttribute("data-del"));
});
$("#sections").addEventListener("change", (e) => {
  const mv = e.target.closest("[data-move]");
  if (mv) moveStaged(mv.getAttribute("data-move"), mv.value);
});

aiChip.addEventListener("click", openAiModal);
$("#aiModalClose").addEventListener("click", closeAiModal);
aiModal.addEventListener("click", (e) => { if (e.target === aiModal) closeAiModal(); });
$("#groqSave").addEventListener("click", () => {
  setGroqKey(groqKeyInput.value); refreshAiChip(); closeAiModal();
  toast(hasGroq() ? "Groq AI connected" : "Key cleared");
  const rulebased = staged.filter((s) => s.aiState === "rule");
  if (hasGroq() && rulebased.length) { rulebased.forEach((s) => (s.aiState = "pending")); render(); classifyBatch(rulebased); }
});
$("#groqRemove").addEventListener("click", () => { setGroqKey(""); groqKeyInput.value = ""; refreshAiChip(); toast("Key removed"); });

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
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !aiModal.hidden) closeAiModal(); });

/* ---------------- Boot ---------------- */

(async function init() {
  injectIcons();
  refreshAiChip();
  setupAuthLink();
  if (Auth.isLoggedIn()) {
    Auth.refresh().then((u) => { if (!u) { setupAuthLink(); render(); } });
    try { staged = await Items.list({ approved: false }); }
    catch (e) { staged = []; toast(e.message); }
  }
  render();
})();
