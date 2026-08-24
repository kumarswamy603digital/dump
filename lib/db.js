/* ============================================================
   Dump — database layer (libSQL / Turso)
   One client used by BOTH the Vercel serverless functions and the
   local Node server. Works with a hosted Turso DB (libsql://…) or a
   local SQLite file (file:…) so `npm start` still runs offline.

   Env:
     TURSO_DATABASE_URL   e.g. libsql://your-db.turso.io   (default: file:server/data/dump.db)
     TURSO_AUTH_TOKEN     Turso auth token (omit for local file: URLs)
   ============================================================ */

"use strict";

const { createClient } = require("@libsql/client");

const url = process.env.TURSO_DATABASE_URL || "file:server/data/dump.db";
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

// intMode:"number" → integer columns come back as plain JS numbers (matches
// the old node:sqlite behaviour; created_at timestamps stay within safe range).
const client = createClient({ url, authToken, intMode: "number" });

/* All columns are declared up-front so a fresh Turso database needs no
   incremental migrations (the old server used ensureColumn ALTERs). */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT,
    category TEXT,
    section TEXT,
    title TEXT,
    subtitle TEXT,
    url TEXT,
    note TEXT,
    thumbnail TEXT,
    mime TEXT,
    file_name TEXT,
    file_data BLOB,
    approved INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    section_id TEXT,
    annotation TEXT,
    cover_data BLOB,
    cover_mime TEXT,
    parent_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id)`,
  `CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sections_user ON sections(user_id)`,
];

// Ensure the schema exists — runs once per process, then memoized so every
// request (and every serverless invocation) reuses the same promise.
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = client.batch(SCHEMA, "write").catch((e) => {
      readyPromise = null; // allow a retry on the next request if it failed
      throw e;
    });
  }
  return readyPromise;
}

/* Thin async helpers mirroring node:sqlite's prepare().all/get/run.
   Params are always passed as an array. */
async function all(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows;
}
async function get(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows[0] || null;
}
async function run(sql, args = []) {
  return client.execute({ sql, args });
}

module.exports = { client, ready, all, get, run, SCHEMA };
