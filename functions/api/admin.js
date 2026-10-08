/* Songflow admin — Cloudflare Pages Function (served at /api/admin). Only for emails listed in
 * public.admins. Powers /admin: see the pool and the waitlist, grant credits, raise the pool.
 * POST { action: "overview" | "grant" (user_id, amount?) | "pool" (amount) }
 */
import { json, configured, whoAmI, rpc, isAdmin } from "../_lib/sb.js";

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return json({ error: "Server not configured." }, 500);
  const user = await whoAmI(request, env);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (!(await isAdmin(env, user.email))) return json({ error: "This page is only for Songflow's admin." }, 403);

  let body = {};
  try { body = await request.json(); } catch (e) { /* overview */ }
  try {
    let result = null;
    if (body.action === "grant") {
      const amount = Number(body.amount) || 5;
      if (!body.user_id || amount <= 0 || amount > 100) return json({ error: "Pick a person and an amount between $0 and $100." }, 400);
      result = await rpc(env, "grant_credits", { p_user: body.user_id, p_amount: amount });
    } else if (body.action === "pool") {
      const amount = Number(body.amount);
      if (!(amount > 0) || amount > 1000) return json({ error: "Enter an amount between $0 and $1,000." }, 400);
      result = await rpc(env, "add_to_pool", { p_amount: amount });
    }
    const overview = await rpc(env, "admin_overview", {});
    return json({ ok: true, result, ...overview });
  } catch (e) {
    return json({ error: "Couldn't reach the database. Try again." }, 503);
  }
}
