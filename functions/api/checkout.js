// POST {plan, email, code?} -> {url} of a Stripe Checkout page for that plan.
import { stripe, priceIds, parseDiscount, json, fail, PLANS } from "../_stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    const plan = String(b.plan || ""), email = String(b.email || "").trim().toLowerCase();
    if (!PLANS[plan]) return fail("Pick a plan first.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a real email address.");
    const ids = await priceIds(env);
    if (!ids[plan]) return fail("This plan isn't set up in Stripe yet.", 500);
    const origin = new URL(request.url).origin;
    const p = {
      mode: "subscription",
      line_items: { 0: { price: ids[plan], quantity: 1 } },
      customer_email: email,
      client_reference_id: email.slice(0, 200),
      metadata: { plan },
      subscription_data: { metadata: { plan } },
      success_url: origin + "/?paid={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/?unpaid=1#pricing",
    };
    if (b.code) {
      const d = await parseDiscount(b.code);
      if (!d) return fail("That discount code isn't right or has ended.");
      if (d.plans.indexOf(plan) < 0) return fail("That code doesn't work on this plan.");
      const id = "ffk-" + d.code.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
      try { await stripe(env, "GET", "coupons/" + id); }
      catch (e) { if (e.status !== 404) throw e; await stripe(env, "POST", "coupons", { id, percent_off: d.pct, duration: "once", name: (d.pct + "% off " + d.code).slice(0, 40) }); }
      p.discounts = { 0: { coupon: id } };
      p.metadata.code = d.code;
    }
    const s = await stripe(env, "POST", "checkout/sessions", p);
    return json({ url: s.url });
  } catch (e) { return fail(e.message || "Checkout failed.", 500); }
}
