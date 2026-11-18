// v57 Forgot password by email.
// POST {action:"send", email}  -> emails a one-time reset link (1 hour) to that address if it has a plan in Stripe.
// POST {action:"confirm", t}   -> checks the link once and returns the plan, like /api/verify, so the page can set
//                                 the new password and bring the plan to this device.
// Needs RESEND_API_KEY in Cloudflare Pages settings (free plan). Optional RESET_FROM, e.g.
// "FirstFoundationkids <hello@firstfoundationkids.com>". Without the key it answers {mail:false} and the page
// tells the parent to email us instead. The one-time code is kept on the Stripe customer (metadata), so no database.
import { stripe, describe, makeToken, json, fail } from "../_stripe.js";

const HOUR = 3600000;
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function rnd() { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const sig = (env, cus, exp, nonce) => hmacHex(env.STRIPE_SECRET_KEY, "ffk-reset:" + cus + ":" + exp + ":" + nonce);

async function bestSub(env, customer) {
  const list = await stripe(env, "GET", "subscriptions", { customer, status: "all", limit: 10 });
  const rank = { active: 0, trialing: 1, past_due: 2 };
  return list.data.slice().sort((a, c) => (rank[a.status] ?? 9) - (rank[c.status] ?? 9) || c.created - a.created)[0] || null;
}

async function send(env, request, email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter the email you used for your plan.");
  if (!env.RESEND_API_KEY) return json({ ok: true, mail: false });
  const found = await stripe(env, "GET", "customers", { email, limit: 10 });
  let cus = null;
  for (const c of found.data) { if (await bestSub(env, c.id)) { cus = c; break; } }
  if (!cus) return json({ ok: true, mail: true }); // same answer either way, so nobody can test which emails are customers
  const last = +(cus.metadata && cus.metadata.ffk_reset_at) || 0;
  if (Date.now() - last < 60000) return json({ ok: true, mail: true }); // one email a minute is plenty
  const nonce = rnd(), exp = Date.now() + HOUR;
  await stripe(env, "POST", "customers/" + cus.id, { metadata: { ffk_reset_nonce: nonce, ffk_reset_at: String(Date.now()) } });
  const t = cus.id + "." + exp + "." + (await sig(env, cus.id, exp, nonce));
  const link = new URL(request.url).origin + "/?reset=" + encodeURIComponent(t) + "#account";
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#223;max-width:520px">
<h2 style="color:#2a9d4b">Reset your FirstFoundationkids password</h2>
<p>Hi${cus.name ? " " + cus.name.replace(/[<>&"]/g, "") : ""},</p>
<p>Someone asked to reset the password for the account with this email. Tap the button to choose a new password. Your plan and your children's games stay the same.</p>
<p><a href="${link}" style="display:inline-block;background:#2a9d4b;color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
<p style="font-size:14px;color:#556">This link works once and ends in 1 hour. If you didn't ask for this, you can ignore this email and nothing changes.</p>
<p style="font-size:14px;color:#556">Need help? Just reply to this email.</p></div>`;
  const text = "Reset your FirstFoundationkids password\n\nOpen this link to choose a new password (works once, ends in 1 hour):\n" + link + "\n\nIf you didn't ask for this, ignore this email and nothing changes.";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: env.RESET_FROM || "FirstFoundationkids <hello@firstfoundationkids.com>", to: [cus.email || email], reply_to: "firstfoundationkidsapp@gmail.com", subject: "Reset your FirstFoundationkids password", html, text }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); return fail("We couldn't send the email right now (" + (d.message || r.status) + "). Please email firstfoundationkidsapp@gmail.com and we'll help.", 502); }
  return json({ ok: true, mail: true });
}

async function confirm(env, t) {
  const m = /^(cus_[A-Za-z0-9]+)\.(\d{12,14})\.([0-9a-f]{64})$/.exec(String(t || ""));
  const bad = () => fail("This reset link has already been used or has ended. Ask for a new one.", 400);
  if (!m || Date.now() > +m[2]) return bad();
  const cus = await stripe(env, "GET", "customers/" + m[1]).catch(() => null);
  const nonce = cus && cus.metadata && cus.metadata.ffk_reset_nonce;
  if (!cus || cus.deleted || !nonce || !same(await sig(env, m[1], m[2], nonce), m[3])) return bad();
  await stripe(env, "POST", "customers/" + m[1], { metadata: { ffk_reset_nonce: "" } }); // used up
  const sub = await bestSub(env, m[1]);
  const d = sub ? await describe(env, sub) : { plan: null, status: "ended", renews: 0 };
  return json({ ...d, email: (cus.email || "").toLowerCase(), name: cus.name || "", customer: m[1], token: await makeToken(env, m[1]) });
}

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    if (b.action === "send") return await send(env, request, String(b.email || "").trim().toLowerCase());
    if (b.action === "confirm") return await confirm(env, b.t);
    return fail("Unknown request.");
  } catch (e) { return fail(e.message || "Something went wrong. Please try again.", 500); }
}
