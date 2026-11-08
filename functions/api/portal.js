// POST {customer, token} -> {url} of Stripe's page where parents switch plans, update their card or cancel.
import { stripe, checkToken, priceIds, json, fail } from "../_stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    if (!(await checkToken(env, b.customer, b.token))) return fail("Not allowed.", 403);
    const p = { customer: b.customer, return_url: new URL(request.url).origin + "/?billing=1#account" };
    let s;
    try { s = await stripe(env, "POST", "billing_portal/sessions", p); }
    catch (e) {
      // First use: Stripe has no customer portal settings yet, so make them once.
      const have = await stripe(env, "GET", "billing_portal/configurations", { is_default: "true", limit: 1 });
      if (have.data.length) throw e;
      const ids = await priceIds(env), prods = {};
      for (const id of Object.values(ids)) { const pr = await stripe(env, "GET", "prices/" + id); (prods[pr.product] = prods[pr.product] || []).push(id); }
      const cfg = await stripe(env, "POST", "billing_portal/configurations", {
        business_profile: { headline: "FirstFoundationkids: manage your plan", privacy_policy_url: "https://www.firstfoundationkids.com/privacy/", terms_of_service_url: "https://www.firstfoundationkids.com/terms/" },
        default_return_url: "https://www.firstfoundationkids.com/?billing=1#account",
        features: {
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          customer_update: { enabled: true, allowed_updates: { 0: "email", 1: "name" } },
          subscription_cancel: { enabled: true, mode: "at_period_end" },
          subscription_update: { enabled: true, default_allowed_updates: { 0: "price" }, proration_behavior: "create_prorations",
            products: Object.fromEntries(Object.entries(prods).map(([prod, prices], i) => [i, { product: prod, prices: Object.fromEntries(prices.map((x, j) => [j, x])) }])) },
        },
      });
      s = await stripe(env, "POST", "billing_portal/sessions", { ...p, configuration: cfg.id });
    }
    return json({ url: s.url });
  } catch (e) { return fail(e.message || "Could not open billing.", 500); }
}
