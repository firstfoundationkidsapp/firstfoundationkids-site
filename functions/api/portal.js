// POST {customer, token} -> {url} of Stripe's page where parents switch plans, update their card or cancel.
import { stripe, checkToken, json, fail } from "../_stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    if (!(await checkToken(env, b.customer, b.token))) return fail("Not allowed.", 403);
    const s = await stripe(env, "POST", "billing_portal/sessions", { customer: b.customer, return_url: new URL(request.url).origin + "/?billing=1#account" });
    return json({ url: s.url });
  } catch (e) { return fail(e.message || "Could not open billing.", 500); }
}
