// Shared helpers for the Stripe API routes (Cloudflare Pages Functions).
// Needs one secret in Cloudflare Pages settings: STRIPE_SECRET_KEY (sk_test_... or sk_live_...).
// Optional: PRICE_MONTHLY, PRICE_YEARLY, PRICE_FAMILY (price_... ids). Without them the prices are
// found in Stripe by amount: $9.99 monthly, $79.99 yearly, $99.99 yearly (Family).
export const PLANS = {
  monthly: { amount: 999, interval: "month", env: "PRICE_MONTHLY" },
  yearly: { amount: 7999, interval: "year", env: "PRICE_YEARLY" },
  family: { amount: 9999, interval: "year", env: "PRICE_FAMILY" },
  classroom15: { amount: 24999, interval: "year", env: "PRICE_CLASS15", classroom: true, seats: 15 },
  classroom30: { amount: 34999, interval: "year", env: "PRICE_CLASS30", classroom: true, seats: 30 },
};
const NAMES = { monthly: "FirstFoundationkids Monthly", yearly: "FirstFoundationkids Yearly", family: "FirstFoundationkids Family", classroom15: "FirstFoundationkids Classroom (up to 15 students)", classroom30: "FirstFoundationkids Classroom (up to 30 students)" };
const DESCS = {
  monthly: "All 30 levels in every learning world for 1 child. Billed every month.",
  yearly: "All 30 levels in every learning world for 1 child. Billed once a year.",
  family: "All 30 levels in every learning world for up to 4 children. Billed once a year.",
  classroom15: "Homework with all 30 levels in every learning world for up to 15 students. Billed once a year.",
  classroom30: "Homework with all 30 levels in every learning world for up to 30 students. Billed once a year.",
};
const CODE_KEY = "ffk:7Hq2wP9z:codes:v1"; // same key the page uses for discount codes
const CB32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export function fail(msg, status = 400) { return json({ error: msg }, status); }

function form(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Payments are not switched on yet (STRIPE_SECRET_KEY is missing).");
  let url = "https://api.stripe.com/v1/" + path, body;
  if (params && method === "GET") url += "?" + form(params).toString();
  else if (params) body = form(params).toString();
  const r = await fetch(url, { method, body, headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" } });
  const d = await r.json();
  if (!r.ok) { const e = new Error((d.error && d.error.message) || "Stripe error"); e.status = r.status; throw e; }
  return d;
}

let priceCache = null;
export async function priceIds(env) {
  if (priceCache && priceCache.key === env.STRIPE_SECRET_KEY) return priceCache.ids;
  const ids = {};
  for (const [p, c] of Object.entries(PLANS)) if (env[c.env]) ids[p] = env[c.env];
  if (Object.keys(ids).length < Object.keys(PLANS).length) {
    const list = await stripe(env, "GET", "prices", { active: "true", type: "recurring", limit: 100 });
    for (const [p, c] of Object.entries(PLANS)) {
      if (ids[p]) continue;
      const m = list.data.filter((x) => x.unit_amount === c.amount && x.currency === "usd" && x.recurring && x.recurring.interval === c.interval && (x.recurring.interval_count || 1) === 1)
        .sort((a, b) => b.created - a.created)[0];
      if (m) ids[p] = m.id;
    }
  }
  // Any plan still missing is created once in Stripe (product + recurring USD price).
  for (const [p, c] of Object.entries(PLANS)) {
    if (ids[p]) continue;
    const prod = await stripe(env, "POST", "products", {
      name: NAMES[p], description: DESCS[p], url: "https://www.firstfoundationkids.com/plans/", metadata: { plan: p },
      default_price_data: { currency: "usd", unit_amount: c.amount, recurring: { interval: c.interval } },
    });
    ids[p] = prod.default_price;
  }
  if (Object.keys(ids).length === Object.keys(PLANS).length) priceCache = { key: env.STRIPE_SECRET_KEY, ids }; // keep looking until all 3 plans exist
  return ids;
}
export async function planOfPrice(env, priceId, amount, interval) {
  const ids = await priceIds(env);
  for (const [p, id] of Object.entries(ids)) if (id === priceId) return p;
  for (const [p, c] of Object.entries(PLANS)) if (c.amount === amount && c.interval === interval) return p;
  return "yearly";
}

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// A token the browser keeps so it can later ask about (or manage) only its own Stripe customer.
export function makeToken(env, customer) { return hmacHex(env.STRIPE_SECRET_KEY, "ffk-customer:" + customer); }
export async function checkToken(env, customer, token) {
  if (!customer || !token) return false;
  const good = await makeToken(env, customer);
  if (good.length !== token.length) return false;
  let d = 0; for (let i = 0; i < good.length; i++) d |= good.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

// Discount codes: NAME-D20[MYF]-[UYYMMDD-]CHECK (same rules as the page). Returns {pct, plans} or null.
export async function parseDiscount(raw) {
  const code = String(raw || "").toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const parts = code.split("-");
  if (parts.length < 3 || parts.length > 4) return null;
  const body = parts.slice(0, -1).join("-"), h = await sha256hex(CODE_KEY + ":" + body);
  let sig = ""; for (let i = 0; i < 5; i++) sig += CB32.charAt(parseInt(h.substr(i * 2, 2), 16) % 32);
  if (parts[parts.length - 1] !== sig) return null;
  const m = /^D(\d{1,3})([MYF]{0,3})$/.exec(parts[1]);
  if (!m || +m[1] < 1 || +m[1] > 100) return null;
  if (parts.length === 4) {
    const u = /^U(\d\d)(\d\d)(\d\d)$/.exec(parts[2]); if (!u) return null;
    if (Date.now() > Date.UTC(2000 + +u[1], +u[2] - 1, +u[3], 23, 59, 59) + 14 * 3600000) return null;
  }
  const L = { M: "monthly", Y: "yearly", F: "family" };
  return { code, pct: +m[1], plans: m[2] ? m[2].split("").map((x) => L[x]) : ["monthly", "yearly", "family"] };
}

function periodEnd(sub) {
  const t = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end) || 0;
  return t * 1000;
}
// Turns a Stripe subscription into what the page stores on the account.
export async function describe(env, sub) {
  const it = sub.items && sub.items.data[0], pr = it && it.price;
  const plan = (sub.metadata && PLANS[sub.metadata.plan] ? sub.metadata.plan : null) || await planOfPrice(env, pr && pr.id, pr && pr.unit_amount, pr && pr.recurring && pr.recurring.interval);
  const live = ["active", "trialing", "past_due"].indexOf(sub.status) >= 0;
  return { plan, status: live ? (sub.cancel_at_period_end || sub.cancel_at || sub.canceled_at ? "cancelled" : "active") : "ended", renews: periodEnd(sub), sub: sub.id, stripeStatus: sub.status };
}
