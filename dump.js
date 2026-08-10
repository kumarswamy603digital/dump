/* ============================================================
   Dump — page 1 (staging)
   Dump things -> classify into 4 sections -> approve -> library
   Requires core.js
   ============================================================ */

let staged = []; // items with approved === false

const $ = (s) => document.querySelector(s);
const fileInput = $("#fileInput");
const linkInput = $("#linkInput");
const dropzone = $("#dropzone");
const dropOverlay = $("#dropOverlay");
const stagingStatus = $("#stagingStatus");
const approveBtn = $("#approveBtn");
const approveCount = $("#approveCount");
let pendingAI = 0; // number of items awaiting AI classification

/* ---------------- Adding to the dump ---------------- */

async function dumpText(raw) {
  const parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  const fresh = [];
  let offset = 0;
  for (const part of parts) {
    const info = detectLink(part);
    const item = {
      id: uid(),
      createdAt: Date.now() + offset++,
      kind: info.url ? "link" : "note",
      category: info.category,
      title: info.title,
      subtitle: info.subtitle || info.domain || "",
      url: info.url,
      thumbnail: info.thumbnail || null,
      note: info.category === "note" ? info.title : null,
      section: sectionOf(info.category),
      approved: false,
      starred: false,
      aiState: hasGroq() ? "pending" : "rule",
    };
    await dbPut(item);
    staged.unshift(item);
    fresh.push(item);
  }
  render();
  classifyBatch(fresh);
}

async function dumpFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const fresh = [];
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
      section: sectionOf(info.category),
      approved: false,
      starred: false,
      aiState: hasGroq() && (file.type || "").startsWith("image/") ? "pending" : "rule",
    };
    await dbPut(item);
    staged.unshift(item);
    fresh.push(item);
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
      if (section && SECTIONS.includes(section)) { live.section = section; live.aiState = "done"; }
      else { live.aiState = "rule"; }
      await dbPut(live);
    }
    pendingAI = Math.max(0, pendingAI - 1);
    render();
  }
  updateStatus();
}

/* ---------------- Mutations ---------------- */

async function removeStaged(id) {
  await dbDelete(id);
  if (objectUrls.has(id)) { URL.revokeObjectURL(objectUrls.get(id)); objectUrls.delete(id); }
  staged = staged.filter((s) => s.id !== id);
  render();
}

async function moveStaged(id, section) {
  const it = staged.find((s) => s.id === id);
  if (!it || !SECTIONS.includes(section)) return;
  it.section = section;
  it.aiState = "manual";
  await dbPut(it);
  render();
}

async function approveAll() {
  if (!staged.length) return;
  const count = staged.length;
  for (const it of staged) { it.approved = true; await dbPut(it); }
  staged = [];
  render();
  toast(`${count} item${count === 1 ? "" : "s"} sent to your library`);
}

/* ---------------- Rendering ---------------- */

function thumbFor(item) {
  const meta = TYPE_META[item.category] || TYPE_META.link;
  if (item.category === "photo") {
    const src = item.kind === "file" ? urlForBlob(item) : (item.thumbnail || item.url);
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
    const body = document.querySelector(`[data-body="${sec}"]`);
    const list = staged.filter((it) => it.section === sec);
    counts[sec] = list.length;
    body.innerHTML = list.length
      ? list.map(dumpCardHtml).join("")
      : `<div class="section-empty">Nothing here yet</div>`;
  });
  document.querySelectorAll("[data-scount]").forEach((el) => { el.textContent = counts[el.dataset.scount]; });

  approveCount.textContent = staged.length;
  approveBtn.disabled = staged.length === 0;
  updateStatus();
}

function updateStatus() {
  if (!staged.length) {
    stagingStatus.textContent = "Nothing dumped yet — drop something above.";
    return;
  }
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

/* ---------------- Wiring ---------------- */

$("#addLinkBtn").addEventListener("click", () => { if (linkInput.value.trim()) { dumpText(linkInput.value); linkInput.value = ""; } });
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && linkInput.value.trim()) { dumpText(linkInput.value); linkInput.value = ""; } });
fileInput.addEventListener("change", () => { dumpFiles(fileInput.files); fileInput.value = ""; });
dropzone.addEventListener("click", (e) => { if (!e.target.closest(".file-pick")) fileInput.click(); });
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });

approveBtn.addEventListener("click", approveAll);

// Section grid interactions
$("#sections").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) removeStaged(del.getAttribute("data-del"));
});
$("#sections").addEventListener("change", (e) => {
  const mv = e.target.closest("[data-move]");
  if (mv) moveStaged(mv.getAttribute("data-move"), mv.value);
});

// AI settings
aiChip.addEventListener("click", openAiModal);
$("#aiModalClose").addEventListener("click", closeAiModal);
aiModal.addEventListener("click", (e) => { if (e.target === aiModal) closeAiModal(); });
$("#groqSave").addEventListener("click", () => {
  setGroqKey(groqKeyInput.value);
  refreshAiChip(); closeAiModal();
  toast(hasGroq() ? "Groq AI connected" : "Key cleared");
  const rulebased = staged.filter((s) => s.aiState === "rule");
  if (hasGroq() && rulebased.length) { rulebased.forEach((s) => (s.aiState = "pending")); render(); classifyBatch(rulebased); }
});
$("#groqRemove").addEventListener("click", () => { setGroqKey(""); groqKeyInput.value = ""; refreshAiChip(); toast("Key removed"); });

// Global drag & drop
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); dragDepth++; dropOverlay.classList.add("show"); }
});
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

function setupAuthLink() {
  const link = document.getElementById("authLink");
  if (!link || typeof currentUser !== "function") return;
  const user = currentUser();
  if (user) {
    link.textContent = `Hi ${firstName(user)} · Sign out`;
    link.href = "#";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      logout();
      toast("Signed out");
      setTimeout(() => location.reload(), 500);
    });
  } else {
    link.textContent = "Sign in";
    link.href = "signin.html";
  }
}

(async function init() {
  injectIcons();
  refreshAiChip();
  setupAuthLink();
  try {
    staged = (await dbAll())
      .filter((it) => it.approved === false)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error("Failed to load staged items", err);
    staged = [];
  }
  render();
})();
