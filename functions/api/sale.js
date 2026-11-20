// GET -> {on, pct, start, end}: whether a Black Friday sale is on right now (server clock), else the next one.
import { json, SALES, currentSale } from "../_stripe.js";

export async function onRequestGet() {
  const now = Date.now();
  const s = currentSale(now) || SALES.find(x => now < x.start) || SALES[SALES.length - 1];
  return json({ on: currentSale(now) !== null, pct: s.pct, start: s.start, end: s.end });
}
