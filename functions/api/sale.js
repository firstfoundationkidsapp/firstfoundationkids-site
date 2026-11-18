// GET -> {on, pct, start, end}: whether the Black Friday sale is on right now (server clock).
import { json, SALE, saleOn } from "../_stripe.js";

export async function onRequestGet() {
  return json({ on: saleOn(), pct: SALE.pct, start: SALE.start, end: SALE.end });
}
