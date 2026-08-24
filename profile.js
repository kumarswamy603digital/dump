/* ============================================================
   Dump — profile page
   Identity, edit profile, change password, stats, AI key,
   danger zone. Requires core.js + api.js
   ============================================================ */

const $ = (s) => document.querySelector(s);

function initials(name) {
  return (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
}
function showMsg(el, text) { el.textContent = text; el.classList.add("show"); }
function hide(el) { el.classList.remove("show"); }

let user = {};

function renderIdentity() {
  $("#avatar").textContent = initials(user.name);
  $("#pName").textContent = user.name || "—";
  $("#pEmail").textContent = user.email || "";
  $("#pSince").textContent = user.createdAt
    ? "Member since " + new Date(user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })
    : "";
  $("#nameInput").value = user.name || "";
  $("#emailInput").value = user.email || "";
}

async function loadStats() {
  try {
    const s = await Account.stats();
    const cells = [
      ["Saved items", s.total],
      ["Pinned", s.pinned],
      ["Sections", s.sections],
      ["In the dump", s.staged],
    ];
    $("#statGrid").innerHTML = cells.map(([l, v]) => `<div class="stat"><div class="stat-num">${v}</div><div class="stat-label">${l}</div></div>`).join("");
    const t = s.byType || {};
    const chips = [["Reels", t.reels], ["PDFs & Docs", t.pdfs], ["Links", t.links], ["Images", t.images], ["Notes", t.notes]];
    $("#typeBreakdown").innerHTML = chips.map(([l, v]) => `<span class="type-chip">${l} <b>${v || 0}</b></span>`).join("");
  } catch (e) { /* stats are best-effort */ }
}

/* ---------------- Boot & wiring ---------------- */
(async function init() {
  if (!Auth.isLoggedIn()) { location.replace("signin.html"); return; }
  injectIcons();
  user = Auth.currentUser() || {};
  renderIdentity();

  // refresh identity from server (best-effort; don't log out on failure)
  const fresh = await Auth.refresh();
  if (fresh) { user = fresh; renderIdentity(); }
  else if (!Auth.isLoggedIn()) { location.replace("signin.html"); return; }

  loadStats();

  // Save profile
  $("#saveProfile").addEventListener("click", async () => {
    const err = $("#profileError"), msg = $("#profileMsg"); hide(err); hide(msg);
    const name = $("#nameInput").value.trim(), email = $("#emailInput").value.trim();
    const patch = {};
    if (name !== (user.name || "")) patch.name = name;
    if (email !== (user.email || "")) patch.email = email;
    if (!Object.keys(patch).length) { showMsg(msg, "Nothing changed."); return; }
    try { user = await Auth.updateProfile(patch); renderIdentity(); showMsg(msg, "Profile updated."); toast("Profile updated"); }
    catch (e) { showMsg(err, e.message); }
  });

  // Change password
  $("#savePw").addEventListener("click", async () => {
    const err = $("#pwError"), msg = $("#pwMsg"); hide(err); hide(msg);
    const cur = $("#curPw").value, np = $("#newPw").value, cf = $("#confPw").value;
    if (np !== cf) { showMsg(err, "New passwords don't match."); return; }
    try {
      await Auth.changePassword(cur, np);
      $("#curPw").value = $("#newPw").value = $("#confPw").value = "";
      showMsg(msg, "Password updated.");
      toast("Password updated");
    } catch (e) { showMsg(err, e.message); }
  });

  // Sign out
  $("#signOutBtn").addEventListener("click", () => { Auth.logout(); toast("Signed out"); setTimeout(() => (location.href = "index.html"), 400); });

  // Delete account
  $("#deleteBtn").addEventListener("click", async () => {
    if (!confirm("Permanently delete your account and everything in it? This can't be undone.")) return;
    try { await Auth.deleteAccount(); toast("Account deleted"); setTimeout(() => (location.href = "index.html"), 700); }
    catch (e) { toast(e.message); }
  });
})();
