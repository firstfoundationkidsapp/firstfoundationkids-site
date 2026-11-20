// POST {plan, email, code?} -> {url} of a Stripe Checkout page for that plan.
import { stripe, priceIds, parseDiscount, json, fail, PLANS, currentSale } from "../_stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    const plan = String(b.plan || ""), email = String(b.email || "").trim().toLowerCase();
    if (!PLANS[plan] || PLANS[plan].classroom) return fail("Pick a plan first.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a real email address.");
    const ids = await priceIds(env);
    if (!ids[plan]) return fail("This plan isn't set up in Stripe yet.", 500);
    const origin = new URL(request.url).origin;
    const p = {
      mode: "subscription",
      managed_payments: { enabled: "false" }, // standard Stripe checkout; Managed Payments needs product tax codes
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
      p.metadata.pct = d.pct;
    }
    // Black Friday: the sale coupon goes on unless a code already gives a bigger discount (Stripe takes one).
    const SALE = currentSale();
    if (SALE && !(p.metadata.code && p.metadata.pct > SALE.pct)) {
      try { await stripe(env, "GET", "coupons/" + SALE.id); }
      catch (e) { if (e.status !== 404) throw e; await stripe(env, "POST", "coupons", { id: SALE.id, percent_off: SALE.pct, duration: "once", name: SALE.name, redeem_by: Math.floor(SALE.end / 1000) }); }
      p.discounts = { 0: { coupon: SALE.id } };
      p.metadata.sale = SALE.id;
      delete p.metadata.code; // the smaller code was not used, so the customer keeps it
    }
    delete p.metadata.pct;
    const s = await stripe(env, "POST", "checkout/sessions", p);
    return json({ url: s.url });
  } catch (e) { return fail(e.message || "Checkout failed.", 500); }
}
