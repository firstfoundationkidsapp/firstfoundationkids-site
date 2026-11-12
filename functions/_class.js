// Classroom (teacher / parent homework) helpers for Cloudflare Pages Functions.
// Storage: a Cloudflare D1 database bound to this Pages project with the variable name DB.
// The tables are made automatically on first use. Optional settings:
//   CLASS_PRO_EMAILS  comma-separated teacher emails that get every level free (friends, test schools)
//   STRIPE_SECRET_KEY already set for payments; used to check a linked plan.
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export function fail(msg, status = 400, extra) { return json(Object.assign({ error: msg }, extra || {}), status); }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teachers (email TEXT PRIMARY KEY, name TEXT, salt TEXT, hash TEXT, created INTEGER, plan_customer TEXT, plan_status TEXT, plan_renews INTEGER, plan_checked INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT, who TEXT, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, teacher TEXT, name TEXT, band INTEGER, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS classes_teacher ON classes(teacher)`,
  `CREATE TABLE IF NOT EXISTS kids (user TEXT PRIMARY KEY, class_id TEXT, name TEXT, salt TEXT, hash TEXT, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS kids_class ON kids(class_id)`,
  `CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, class_id TEXT, game TEXT, band INTEGER, lv_from INTEGER, lv_to INTEGER, note TEXT, due TEXT, kids TEXT, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS assign_class ON assignments(class_id)`,
  `CREATE TABLE IF NOT EXISTS progress (user TEXT, akey TEXT, stars INTEGER, at INTEGER, PRIMARY KEY(user, akey))`,
  `CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER, until INTEGER)`,
];
let ready = null;
export async function db(env) {
  if (!env.DB) { const e = new Error("Classrooms are not switched on yet: the site owner needs to connect a D1 database named DB in Cloudflare."); e.status = 503; e.code = "nodb"; throw e; }
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  await ready;
  return env.DB;
}

const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
export function randInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
export async function sha(s) { return hex(await crypto.subtle.digest("SHA-256", te.encode(s))); }
export async function pwHash(pw, salt) {
  const k = await crypto.subtle.importKey("raw", te.encode(String(pw)), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode(salt), iterations: 20000 }, k, 256));
}
export function same(a, b) { a = String(a || ""); b = String(b || ""); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

const DAY = 86400000;
export async function newSession(D, kind, who) {
  const token = randHex(24), exp = Date.now() + (kind === "t" ? 30 : 180) * DAY;
  await D.prepare("INSERT INTO sessions (token, kind, who, expires) VALUES (?, ?, ?, ?)").bind(await sha(token), kind, who, exp).run();
  if (randInt(20) === 0) await D.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
  return token;
}
export async function session(D, request) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(request.headers.get("authorization") || "");
  if (!m) return null;
  const r = await D.prepare("SELECT kind, who, expires FROM sessions WHERE token = ?").bind(await sha(m[1])).first();
  if (!r || r.expires < Date.now()) return null;
  return { kind: r.kind, who: r.who, token: m[1] };
}
export async function endSession(D, token) { await D.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha(token)).run(); }

// Slows down password guessing: 8 wrong tries per name and place, then a 10 minute wait.
export async function tooMany(D, key) { const r = await D.prepare("SELECT n, until FROM fails WHERE k = ?").bind(key).first(); return !!r && r.n >= 8 && r.until > Date.now(); }
export async function failed(D, key) {
  const r = await D.prepare("SELECT n, until FROM fails WHERE k = ?").bind(key).first();
  const n = r && r.until > Date.now() ? r.n + 1 : 1;
  await D.prepare("INSERT OR REPLACE INTO fails (k, n, until) VALUES (?, ?, ?)").bind(key, n, Date.now() + 10 * 60000).run();
}
export async function cleared(D, key) { await D.prepare("DELETE FROM fails WHERE k = ?").bind(key).run(); }

const WORDS = ["frog", "star", "moon", "cake", "fish", "bear", "duck", "kite", "lion", "boat", "tree", "sun", "bee", "owl", "pig", "cat", "dog", "hat", "jam", "pie", "car", "bus", "egg", "fox"];
export function kidPassword() { return WORDS[randInt(WORDS.length)] + (10 + randInt(90)); }
export function cleanUser(u) { return String(u || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20); }
export function cleanName(n, max) { return String(n || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max || 40); }
export function cleanEmail(e) { return String(e || "").trim().toLowerCase().slice(0, 200); }
