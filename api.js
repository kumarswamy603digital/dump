/* ============================================================
   Dump — frontend API client
   Talks to the Node backend. Handles the JWT token, auth,
   items CRUD, and file (base64) uploads. Same-origin.
   ============================================================ */

const TOKEN_LS = "dump-token";
const USER_LS = "dump-user";

/* ---------------- token + cached user ---------------- */
function getToken() { try { return localStorage.getItem(TOKEN_LS) || ""; } catch { return ""; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_LS, t) : localStorage.removeItem(TOKEN_LS); } catch {} }
function getCachedUser() { try { return JSON.parse(localStorage.getItem(USER_LS) || "null"); } catch { return null; } }
function setCachedUser(u) { try { u ? localStorage.setItem(USER_LS, JSON.stringify(u)) : localStorage.removeItem(USER_LS); } catch {} }

/* ---------------- low-level fetch ---------------- */
async function apiFetch(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && getToken()) headers["Authorization"] = `Bearer ${getToken()}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Can't reach the server. Is it running?");
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) { setToken(""); setCachedUser(null); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/* ---------------- auth ---------------- */
const Auth = {
  isLoggedIn() { return !!getToken(); },
  currentUser() { return getCachedUser(); },
  firstName() { return (getCachedUser()?.name || "").trim().split(/\s+/)[0] || "there"; },

  async signup({ name, email, password }) {
    const d = await apiFetch("/api/auth/signup", { method: "POST", auth: false, body: { name, email, password } });
    setToken(d.token); setCachedUser(d.user);
    return d.user;
  },
  async login(email, password) {
    const d = await apiFetch("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
    setToken(d.token); setCachedUser(d.user);
    return d.user;
  },
  logout() { setToken(""); setCachedUser(null); },

  // Verify the token against the server; refreshes cached user or logs out.
  async refresh() {
    if (!getToken()) return null;
    try { const d = await apiFetch("/api/auth/me"); setCachedUser(d.user); return d.user; }
    catch { return null; }
  },

  async updateProfile(patch) {
    const d = await apiFetch("/api/auth/me", { method: "PATCH", body: patch });
    setCachedUser(d.user);
    return d.user;
  },
  async changePassword(currentPassword, newPassword) {
    await apiFetch("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } });
  },
  async deleteAccount() {
    await apiFetch("/api/account", { method: "DELETE" });
    setToken(""); setCachedUser(null);
  },
};

/* ---------------- account stats ---------------- */
const Account = {
  async stats() { const d = await apiFetch("/api/stats"); return d.stats; },
};

/* ---------------- items ---------------- */
const Items = {
  async list({ approved } = {}) {
    const q = approved === undefined ? "" : `?approved=${approved ? "true" : "false"}`;
    const d = await apiFetch(`/api/items${q}`);
    return d.items;
  },
  async create(item) {
    const d = await apiFetch("/api/items", { method: "POST", body: item });
    return d.item;
  },
  async update(id, patch) {
    const d = await apiFetch(`/api/items/${id}`, { method: "PATCH", body: patch });
    return d.item;
  },
  async remove(id) { await apiFetch(`/api/items/${id}`, { method: "DELETE" }); },

  // Build an item payload from a File (reads it as base64 for upload).
  async fileToPayload(file, base) {
    const dataUrl = await blobToDataURL(file);
    return { ...base, fileData: dataUrl, fileName: file.name, mime: file.type };
  },

  // Authenticated file URL usable in <img src> / <a href>.
  fileUrl(item) { return item.fileUrl ? `${item.fileUrl}?token=${encodeURIComponent(getToken())}` : null; },
};

/* ---------------- sections (custom collections) ---------------- */
const Sections = {
  async list() { const d = await apiFetch("/api/sections"); return d.sections; },
  async create(name) { const d = await apiFetch("/api/sections", { method: "POST", body: { name } }); return d.section; },
  async remove(id) { await apiFetch(`/api/sections/${id}`, { method: "DELETE" }); },
};
