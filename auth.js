/* ============================================================
   Dump — client-side demo auth (localStorage)
   NOTE: This is a prototype auth for a no-backend app. Passwords
   are lightly hashed and stored in the browser only — this is NOT
   secure and must be replaced by a real backend before production.
   ============================================================ */

const AUTH_USERS_LS = "dump-users";
const AUTH_SESSION_LS = "dump-session";

function _loadUsers() {
  try { return JSON.parse(localStorage.getItem(AUTH_USERS_LS) || "[]"); }
  catch { return []; }
}
function _saveUsers(users) {
  try { localStorage.setItem(AUTH_USERS_LS, JSON.stringify(users)); } catch {}
}

// Tiny non-cryptographic hash — obfuscation only, not real security.
function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function currentUser() {
  let email = null;
  try { email = localStorage.getItem(AUTH_SESSION_LS); } catch {}
  if (!email) return null;
  return _loadUsers().find((u) => u.email === email) || null;
}

function isLoggedIn() { return !!currentUser(); }

function registerUser({ name, email, password }) {
  name = (name || "").trim();
  email = (email || "").trim().toLowerCase();
  if (!name) return { ok: false, error: "Please enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!password || password.length < 6) return { ok: false, error: "Password must be at least 6 characters." };

  const users = _loadUsers();
  if (users.some((u) => u.email === email)) return { ok: false, error: "An account with this email already exists." };

  users.push({ name, email, pass: _hash(password), createdAt: Date.now() });
  _saveUsers(users);
  try { localStorage.setItem(AUTH_SESSION_LS, email); } catch {}
  return { ok: true };
}

function loginUser(email, password) {
  email = (email || "").trim().toLowerCase();
  const user = _loadUsers().find((u) => u.email === email);
  if (!user || user.pass !== _hash(password || "")) {
    return { ok: false, error: "Wrong email or password." };
  }
  try { localStorage.setItem(AUTH_SESSION_LS, email); } catch {}
  return { ok: true };
}

function logout() {
  try { localStorage.removeItem(AUTH_SESSION_LS); } catch {}
}

function firstName(user) {
  return (user?.name || "").trim().split(/\s+/)[0] || "there";
}
