/* Songflow tester access — Cloudflare Pages Function (served at /api/access).
 *
 * Called by the studio when someone signs in (and from the credit meter). The first call decides,
 * once, whether they get a tester spot: a spot is a $5 allowance the shared pool can still
 * reserve. When it can't, they are offered the waitlist. POST {action:"join"} joins it.
 * Response: { status: active|used_up|waitlist|full, balance, position, admin }
 */
import { json, configured, whoAmI, rpc, ensureRow, isAdmin } from "../_lib/sb.js";

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return json({ error: "Server not configured." }, 500);
  const user = await whoAmI(request, env);
  if (!user) return json({ error: "Sign in first." }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty body = status check */ }
  try {
    await ensureRow(env, user);
    const status = await rpc(env, body.action === "join" ? "join_waitlist" : "claim_access", { p_user: user.id });
    const [balance, position, admin] = await Promise.all([
      rpc(env, "credit_remaining", { p_user: user.id }),
      rpc(env, "waitlist_position", { p_user: user.id }),
      isAdmin(env, user.email)
    ]);
    return json({ status, balance: Math.max(0, Number(balance) || 0), position: position == null ? null : Number(position), admin });
  } catch (e) {
    return json({ error: "Couldn't check your access. Try again." }, 503);
  }
}
