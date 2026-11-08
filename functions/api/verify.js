// GET ?session_id=cs_... -> the plan the parent just paid for, plus a token for later status checks.
import { stripe, describe, makeToken, json, fail } from "../_stripe.js";

export async function onRequestGet({ request, env }) {
  try {
    const id = new URL(request.url).searchParams.get("session_id") || "";
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return fail("Bad session.");
    const s = await stripe(env, "GET", "checkout/sessions/" + id, { expand: { 0: "subscription" } });
    if (s.status !== "complete" || !s.subscription) return fail("This payment isn't finished.", 402);
    const sub = typeof s.subscription === "string" ? await stripe(env, "GET", "subscriptions/" + s.subscription) : s.subscription;
    const d = await describe(env, sub);
    const email = ((s.customer_details && s.customer_details.email) || s.customer_email || "").toLowerCase();
    return json({ ...d, email, name: (s.customer_details && s.customer_details.name) || "", customer: s.customer, token: await makeToken(env, s.customer), code: (s.metadata && s.metadata.code) || "" });
  } catch (e) { return fail(e.message || "Could not check the payment.", 500); }
}
