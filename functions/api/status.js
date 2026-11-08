// POST {customer, token} -> the current state of that customer's plan (renewed, cancelled, ended).
import { stripe, describe, checkToken, json, fail } from "../_stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json().catch(() => ({}));
    if (!(await checkToken(env, b.customer, b.token))) return fail("Not allowed.", 403);
    const list = await stripe(env, "GET", "subscriptions", { customer: b.customer, status: "all", limit: 10 });
    const rank = { active: 0, trialing: 1, past_due: 2 };
    const subs = list.data.slice().sort((a, c) => (rank[a.status] ?? 9) - (rank[c.status] ?? 9) || c.created - a.created);
    if (!subs.length) return json({ status: "ended", plan: null, renews: 0 });
    return json(await describe(env, subs[0]));
  } catch (e) { return fail(e.message || "Could not check the plan.", 500); }
}
