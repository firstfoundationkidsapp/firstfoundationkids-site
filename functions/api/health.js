// GET -> is the payment server set up? Shows only yes/no facts, never the key.
import { priceIds, json } from "../_stripe.js";

export async function onRequestGet({ env }) {
  const out = { ok: true, key: !!env.STRIPE_SECRET_KEY, mode: env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.indexOf("_live_") > 0 ? "live" : "test") : null, plans: {} };
  if (out.key) {
    try { const ids = await priceIds(env); for (const p of ["monthly", "yearly", "family"]) out.plans[p] = !!ids[p]; }
    catch (e) { out.stripeError = e.message; }
  }
  return json(out);
}
