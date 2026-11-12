// POST /api/class {action, ...} -> classroom accounts: teachers and parents make classes, kid logins and homework.
// GET  /api/class -> {ok, db} (is the database connected?)
// Sign-in comes back as a token; send it as "authorization: Bearer <token>".
import { json, fail, db, randHex, randInt, pwHash, same, newSession, session, endSession, tooMany, failed, cleared, kidPassword, cleanUser, cleanName, cleanEmail } from "../_class.js";
import { stripe, checkToken, describe } from "../_stripe.js";

const FREE_TO = 3, MAX_CLASSES = 40, MAX_KIDS = 60, MAX_ASSIGN = 300;

export async function onRequestGet({ env }) {
  try { await db(env); return json({ ok: true, db: true }); }
  catch (e) { return json({ ok: true, db: false, error: e.message }); }
}

export async function onRequestPost({ request, env }) {
  let D;
  try { D = await db(env); }
  catch (e) { return fail(e.message, e.status || 500, { code: e.code || "dberror" }); }
  try {
    const b = await request.json().catch(() => ({}));
    const act = String(b.action || "");
    const ip = request.headers.get("cf-connecting-ip") || "x";
    const h = HANDLERS[act];
    if (!h) return fail("Unknown action.");
    const s = await session(D, request);
    if (h.who && (!s || s.kind !== h.who)) return fail(h.who === "t" ? "Please sign in again." : "Please log in again.", 401, { code: "signin" });
    return await h.run({ b, env, D, s, ip });
  } catch (e) { return fail(e.message || "Something went wrong.", e.status || 500); }
}

async function teacherRow(D, email) { return D.prepare("SELECT * FROM teachers WHERE email = ?").bind(email).first(); }
function proList(env) { return String(env.CLASS_PRO_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean); }
// Does this teacher have a paid plan? (a linked Stripe plan, or listed in CLASS_PRO_EMAILS)
async function isPro(env, D, t) {
  if (!t) return false;
  if (proList(env).indexOf(t.email) >= 0) return true;
  if (!t.plan_customer) return false;
  if (env.STRIPE_SECRET_KEY && Date.now() - (t.plan_checked || 0) > 6 * 3600000) {
    try {
      const d = await planOf(env, t.plan_customer);
      await D.prepare("UPDATE teachers SET plan_status = ?, plan_renews = ?, plan_checked = ? WHERE email = ?").bind(d.status, d.renews, Date.now(), t.email).run();
      t.plan_status = d.status; t.plan_renews = d.renews;
    } catch (e) { /* keep the last known state */ }
  }
  return (t.plan_status === "active" || t.plan_status === "cancelled") && (t.plan_renews || 0) > Date.now();
}
async function planOf(env, customer) {
  const list = await stripe(env, "GET", "subscriptions", { customer, status: "all", limit: 10 });
  const rank = { active: 0, trialing: 1, past_due: 2 };
  const subs = list.data.slice().sort((a, c) => (rank[a.status] ?? 9) - (rank[c.status] ?? 9) || c.created - a.created);
  if (!subs.length) return { status: "ended", renews: 0, plan: null };
  return describe(env, subs[0]);
}
function pubTeacher(t, pro) { return { email: t.email, name: t.name, pro, plan: t.plan_customer ? { status: t.plan_status, renews: t.plan_renews } : null }; }
async function ownClass(D, s, id) {
  const c = await D.prepare("SELECT * FROM classes WHERE id = ?").bind(String(id || "")).first();
  if (!c || c.teacher !== s.who) { const e = new Error("That class isn't yours."); e.status = 403; throw e; }
  return c;
}
function pubAssign(a) { return { id: a.id, classId: a.class_id, game: a.game, band: a.band, from: a.lv_from, to: a.lv_to, note: a.note || "", due: a.due || "", kids: a.kids ? JSON.parse(a.kids) : null, created: a.created }; }
async function classFull(D, c) {
  const kids = (await D.prepare("SELECT user, name, created FROM kids WHERE class_id = ? ORDER BY name").bind(c.id).all()).results;
  const asg = (await D.prepare("SELECT * FROM assignments WHERE class_id = ? ORDER BY created DESC").bind(c.id).all()).results.map(pubAssign);
  return { id: c.id, name: c.name, band: c.band, created: c.created, kids, assignments: asg };
}
function checkPw(pw) { pw = String(pw || ""); if (pw.length < 8) throw Object.assign(new Error("Use a password with at least 8 characters."), { status: 400 }); if (pw.length > 200) throw Object.assign(new Error("That password is too long."), { status: 400 }); return pw; }
async function uniqueUser(D, base) {
  base = cleanUser(base).replace(/^[0-9]+/, "").slice(0, 12) || "kid";
  for (let i = 0; i < 30; i++) {
    const u = base + (10 + randInt(i < 15 ? 90 : 900));
    if (!(await D.prepare("SELECT 1 FROM kids WHERE user = ?").bind(u).first())) return u;
  }
  throw new Error("Could not make a username. Try another name.");
}
function cleanAssign(b) {
  const game = String(b.game || "");
  if (!/^[a-z0-9]{2,24}$/.test(game)) throw Object.assign(new Error("Pick a game."), { status: 400 });
  const band = Math.round(+b.band), from = Math.round(+b.from), to = Math.round(+b.to);
  if (!(band >= 1 && band <= 6)) throw Object.assign(new Error("Pick an age group or grade."), { status: 400 });
  if (!(from >= 1 && from <= 30 && to >= from && to <= 30)) throw Object.assign(new Error("Pick levels between 1 and 30."), { status: 400 });
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || "")) ? String(b.due) : "";
  const kids = Array.isArray(b.kids) && b.kids.length ? b.kids.map(cleanUser).filter(Boolean).slice(0, MAX_KIDS) : null;
  return { game, band, from, to, due, note: cleanName(b.note, 200), kids };
}

const HANDLERS = {
  /* ---------- grown-ups ---------- */
  signup: { run: async ({ b, D }) => {
    const email = cleanEmail(b.email), name = cleanName(b.name, 60) || "Teacher";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a real email address.");
    const pw = checkPw(b.password);
    if (await teacherRow(D, email)) return fail("There's already a classroom account for this email. Sign in instead.", 409);
    const salt = randHex(12);
    await D.prepare("INSERT INTO teachers (email, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)").bind(email, name, salt, await pwHash(pw, salt), Date.now()).run();
    return json({ token: await newSession(D, "t", email) });
  } },
  login: { run: async ({ b, D, ip }) => {
    const email = cleanEmail(b.email), key = "t:" + email + ":" + ip;
    if (await tooMany(D, key)) return fail("Too many tries. Please wait 10 minutes.", 429);
    const t = await teacherRow(D, email);
    if (!t || !same(await pwHash(String(b.password || ""), t.salt), t.hash)) { await failed(D, key); return fail("That email and password don't match.", 401); }
    await cleared(D, key);
    return json({ token: await newSession(D, "t", email) });
  } },
  logout: { run: async ({ D, s }) => { if (s) await endSession(D, s.token); return json({ ok: true }); } },
  password: { who: "t", run: async ({ b, D, s }) => {
    const t = await teacherRow(D, s.who);
    if (!same(await pwHash(String(b.old || ""), t.salt), t.hash)) return fail("Your current password isn't right.", 401);
    const pw = checkPw(b.password), salt = randHex(12);
    await D.prepare("UPDATE teachers SET salt = ?, hash = ? WHERE email = ?").bind(salt, await pwHash(pw, salt), s.who).run();
    return json({ ok: true });
  } },
  me: { who: "t", run: async ({ env, D, s }) => {
    const t = await teacherRow(D, s.who); if (!t) return fail("Please sign in again.", 401, { code: "signin" });
    const cs = (await D.prepare("SELECT * FROM classes WHERE teacher = ? ORDER BY created").bind(s.who).all()).results;
    const classes = []; for (const c of cs) classes.push(await classFull(D, c));
    return json({ teacher: pubTeacher(t, await isPro(env, D, t)), classes, freeTo: FREE_TO });
  } },
  linkplan: { who: "t", run: async ({ b, env, D, s }) => {
    if (!(await checkToken(env, b.customer, b.token))) return fail("We couldn't find a paid plan on this device.", 403);
    const other = await D.prepare("SELECT email FROM teachers WHERE plan_customer = ? AND email != ?").bind(b.customer, s.who).first();
    if (other) return fail("This plan is already linked to another classroom account.", 409);
    const d = await planOf(env, b.customer);
    await D.prepare("UPDATE teachers SET plan_customer = ?, plan_status = ?, plan_renews = ?, plan_checked = ? WHERE email = ?").bind(b.customer, d.status, d.renews, Date.now(), s.who).run();
    const t = await teacherRow(D, s.who);
    return json({ teacher: pubTeacher(t, await isPro(env, D, t)) });
  } },
  unlinkplan: { who: "t", run: async ({ env, D, s }) => {
    await D.prepare("UPDATE teachers SET plan_customer = NULL, plan_status = NULL, plan_renews = NULL WHERE email = ?").bind(s.who).run();
    const t = await teacherRow(D, s.who);
    return json({ teacher: pubTeacher(t, await isPro(env, D, t)) });
  } },
  deleteaccount: { who: "t", run: async ({ b, D, s }) => {
    const t = await teacherRow(D, s.who);
    if (!same(await pwHash(String(b.password || ""), t.salt), t.hash)) return fail("Your password isn't right.", 401);
    const cs = (await D.prepare("SELECT id FROM classes WHERE teacher = ?").bind(s.who).all()).results;
    for (const c of cs) await dropClass(D, c.id);
    await D.batch([D.prepare("DELETE FROM teachers WHERE email = ?").bind(s.who), D.prepare("DELETE FROM sessions WHERE kind = 't' AND who = ?").bind(s.who)]);
    return json({ ok: true });
  } },

  /* ---------- classes ---------- */
  addclass: { who: "t", run: async ({ b, D, s }) => {
    const n = await D.prepare("SELECT COUNT(*) AS n FROM classes WHERE teacher = ?").bind(s.who).first();
    if (n.n >= MAX_CLASSES) return fail("You can have up to " + MAX_CLASSES + " classes.");
    const band = Math.round(+b.band); if (!(band >= 1 && band <= 6)) return fail("Pick an age group or grade.");
    const c = { id: "c" + randHex(6), teacher: s.who, name: cleanName(b.name, 50) || "My class", band, created: Date.now() };
    await D.prepare("INSERT INTO classes (id, teacher, name, band, created) VALUES (?, ?, ?, ?, ?)").bind(c.id, c.teacher, c.name, c.band, c.created).run();
    return json({ cls: await classFull(D, c) });
  } },
  editclass: { who: "t", run: async ({ b, D, s }) => {
    const c = await ownClass(D, s, b.classId);
    const name = b.name != null ? cleanName(b.name, 50) || c.name : c.name, band = b.band != null && +b.band >= 1 && +b.band <= 6 ? Math.round(+b.band) : c.band;
    await D.prepare("UPDATE classes SET name = ?, band = ? WHERE id = ?").bind(name, band, c.id).run();
    return json({ cls: await classFull(D, Object.assign(c, { name, band })) });
  } },
  delclass: { who: "t", run: async ({ b, D, s }) => { const c = await ownClass(D, s, b.classId); await dropClass(D, c.id); return json({ ok: true }); } },

  /* ---------- kids ---------- */
  addkids: { who: "t", run: async ({ b, D, s }) => {
    const c = await ownClass(D, s, b.classId);
    const list = (Array.isArray(b.kids) ? b.kids : []).map((k) => ({ name: cleanName(k && k.name, 30), user: cleanUser(k && k.user), password: String((k && k.password) || "").trim() })).filter((k) => k.name);
    if (!list.length) return fail("Type at least one name.");
    const n = await D.prepare("SELECT COUNT(*) AS n FROM kids WHERE class_id = ?").bind(c.id).first();
    if (n.n + list.length > MAX_KIDS) return fail("A class can have up to " + MAX_KIDS + " kids.");
    const made = [];
    for (const k of list) {
      let user = k.user;
      if (user) {
        if (user.length < 3) return fail("Usernames need at least 3 letters or numbers: " + user);
        if (await D.prepare("SELECT 1 FROM kids WHERE user = ?").bind(user).first()) return fail("The username " + user + " is taken. Try another one, or leave it empty.", 409);
      } else user = await uniqueUser(D, k.name);
      const pw = k.password ? k.password.slice(0, 40) : kidPassword();
      if (pw.length < 4) return fail("Kid passwords need at least 4 characters.");
      const salt = randHex(8);
      await D.prepare("INSERT INTO kids (user, class_id, name, salt, hash, created) VALUES (?, ?, ?, ?, ?, ?)").bind(user, c.id, k.name, salt, await pwHash(pw.toLowerCase(), salt), Date.now()).run();
      made.push({ user, name: k.name, password: pw });
    }
    return json({ made, cls: await classFull(D, c) });
  } },
  resetkid: { who: "t", run: async ({ b, D, s }) => {
    const k = await D.prepare("SELECT * FROM kids WHERE user = ?").bind(cleanUser(b.user)).first();
    if (!k) return fail("That kid isn't in your class.", 404);
    await ownClass(D, s, k.class_id);
    const pw = String(b.password || "").trim().slice(0, 40) || kidPassword();
    if (pw.length < 4) return fail("Kid passwords need at least 4 characters.");
    const salt = randHex(8);
    await D.batch([D.prepare("UPDATE kids SET salt = ?, hash = ? WHERE user = ?").bind(salt, await pwHash(pw.toLowerCase(), salt), k.user),
      D.prepare("DELETE FROM sessions WHERE kind = 'k' AND who = ?").bind(k.user)]);
    return json({ user: k.user, name: k.name, password: pw });
  } },
  renamekid: { who: "t", run: async ({ b, D, s }) => {
    const k = await D.prepare("SELECT * FROM kids WHERE user = ?").bind(cleanUser(b.user)).first();
    if (!k) return fail("That kid isn't in your class.", 404);
    await ownClass(D, s, k.class_id);
    const name = cleanName(b.name, 30); if (!name) return fail("Type a name.");
    await D.prepare("UPDATE kids SET name = ? WHERE user = ?").bind(name, k.user).run();
    return json({ ok: true });
  } },
  delkid: { who: "t", run: async ({ b, D, s }) => {
    const k = await D.prepare("SELECT * FROM kids WHERE user = ?").bind(cleanUser(b.user)).first();
    if (!k) return fail("That kid isn't in your class.", 404);
    await ownClass(D, s, k.class_id);
    await D.batch([D.prepare("DELETE FROM kids WHERE user = ?").bind(k.user), D.prepare("DELETE FROM progress WHERE user = ?").bind(k.user), D.prepare("DELETE FROM sessions WHERE kind = 'k' AND who = ?").bind(k.user)]);
    return json({ ok: true });
  } },

  /* ---------- homework ---------- */
  assign: { who: "t", run: async ({ b, env, D, s }) => {
    const c = await ownClass(D, s, b.classId), a = cleanAssign(b);
    if (a.to > FREE_TO && !(await isPro(env, D, await teacherRow(D, s.who)))) return fail("Levels 4 to 30 need a plan. Free classrooms can give levels 1 to 3 of every game.", 402, { code: "needplan" });
    const n = await D.prepare("SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?").bind(c.id).first();
    if (n.n >= MAX_ASSIGN) return fail("This class has a lot of homework already. Delete some old ones first.");
    const id = "a" + randHex(6);
    await D.prepare("INSERT INTO assignments (id, class_id, game, band, lv_from, lv_to, note, due, kids, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, c.id, a.game, a.band, a.from, a.to, a.note, a.due, a.kids ? JSON.stringify(a.kids) : null, Date.now()).run();
    return json({ cls: await classFull(D, c) });
  } },
  unassign: { who: "t", run: async ({ b, D, s }) => {
    const a = await D.prepare("SELECT * FROM assignments WHERE id = ?").bind(String(b.id || "")).first();
    if (!a) return fail("That homework is already gone.", 404);
    const c = await ownClass(D, s, a.class_id);
    await D.prepare("DELETE FROM assignments WHERE id = ?").bind(a.id).run();
    return json({ cls: await classFull(D, c) });
  } },
  progress: { who: "t", run: async ({ b, D, s }) => {
    const c = await ownClass(D, s, b.classId);
    const rows = (await D.prepare("SELECT p.user, p.akey, p.stars, p.at FROM progress p JOIN kids k ON k.user = p.user WHERE k.class_id = ?").bind(c.id).all()).results;
    const out = {}; rows.forEach((r) => { (out[r.user] = out[r.user] || {})[r.akey] = [r.stars, r.at]; });
    return json({ progress: out });
  } },

  /* ---------- kids ---------- */
  kidlogin: { run: async ({ b, D, ip }) => {
    const user = cleanUser(b.user), key = "k:" + user + ":" + ip;
    if (!user) return fail("Type your username.");
    if (await tooMany(D, key)) return fail("Too many tries. Ask your teacher or grown-up for help.", 429);
    const k = await D.prepare("SELECT * FROM kids WHERE user = ?").bind(user).first();
    if (!k || !same(await pwHash(String(b.password || "").trim().toLowerCase(), k.salt), k.hash)) { await failed(D, key); return fail("Hmm, that username and password don't match. Try again!", 401); }
    await cleared(D, key);
    return json({ token: await newSession(D, "k", k.user) });
  } },
  kidme: { who: "k", run: async ({ env, D, s }) => {
    const k = await D.prepare("SELECT * FROM kids WHERE user = ?").bind(s.who).first(); if (!k) return fail("Please log in again.", 401, { code: "signin" });
    const c = await D.prepare("SELECT * FROM classes WHERE id = ?").bind(k.class_id).first(); if (!c) return fail("Your class is gone. Ask your teacher.", 401, { code: "signin" });
    const t = await teacherRow(D, c.teacher), pro = await isPro(env, D, t);
    const asg = (await D.prepare("SELECT * FROM assignments WHERE class_id = ? ORDER BY created DESC").bind(c.id).all()).results.map(pubAssign).filter((a) => !a.kids || a.kids.indexOf(k.user) >= 0);
    const prog = {}; (await D.prepare("SELECT akey, stars FROM progress WHERE user = ?").bind(k.user).all()).results.forEach((r) => { prog[r.akey] = r.stars; });
    return json({ kid: { user: k.user, name: k.name }, cls: { name: c.name, band: c.band, teacher: t ? t.name : "" }, pro, freeTo: FREE_TO, assignments: asg, progress: prog });
  } },
  kidstars: { who: "k", run: async ({ b, D, s }) => {
    const m = /^([a-z0-9]{2,24})-([1-6])-([0-9]{1,2})$/.exec(String(b.key || "")), stars = Math.round(+b.stars);
    if (!m || +m[3] < 1 || +m[3] > 30 || !(stars >= 0 && stars <= 5)) return fail("Bad level.");
    // keep the best score for each level
    await D.prepare("INSERT INTO progress (user, akey, stars, at) VALUES (?, ?, ?, ?) ON CONFLICT(user, akey) DO UPDATE SET stars = MAX(stars, excluded.stars), at = excluded.at").bind(s.who, b.key, stars, Date.now()).run();
    return json({ ok: true });
  } },
};
async function dropClass(D, id) {
  const kids = (await D.prepare("SELECT user FROM kids WHERE class_id = ?").bind(id).all()).results.map((r) => r.user);
  const st = [D.prepare("DELETE FROM assignments WHERE class_id = ?").bind(id), D.prepare("DELETE FROM kids WHERE class_id = ?").bind(id), D.prepare("DELETE FROM classes WHERE id = ?").bind(id)];
  kids.forEach((u) => { st.push(D.prepare("DELETE FROM progress WHERE user = ?").bind(u)); st.push(D.prepare("DELETE FROM sessions WHERE kind = 'k' AND who = ?").bind(u)); });
  await D.batch(st);
}
