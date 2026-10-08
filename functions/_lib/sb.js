/* Shared helpers for the Songflow server functions (folders starting with "_" are not routes).
 * Everything here runs server-side with the service key from the Cloudflare environment. */

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export const configured = env => !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);

const sbHeaders = env => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  "content-type": "application/json"
});

/* the signed-in person behind this request (their Supabase session token), or null */
export async function whoAmI(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: env.SUPABASE_SERVICE_KEY } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: String(u.email || "").toLowerCase() } : null;
  } catch (e) { return null; }
}

export async function rpc(env, fn, args) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: sbHeaders(env), body: JSON.stringify(args || {})
  });
  if (!r.ok) throw new Error(`${fn} failed (${r.status})`);
  return r.json();
}

/* make sure the person has a credits row (the sign-up trigger normally creates it) */
export async function ensureRow(env, user) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/credits`, {
    method: "POST", headers: { ...sbHeaders(env), Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({ user_id: user.id, email: user.email })
  });
}

export async function isAdmin(env, email) {
  if (!email) return false;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?select=email&email=eq.${encodeURIComponent(email)}`, { headers: sbHeaders(env) });
    if (!r.ok) return false;
    return (await r.json()).length > 0;
  } catch (e) { return false; }
}

/* what a tester sees when included credits aren't available, by access status */
export const ACCESS_MESSAGES = {
  full: "Songflow's tester spots are full right now. Join the waitlist and we'll open your included credits as spots free up — or add your own key in the Engine box to generate now.",
  waitlist: "You're on the waitlist for included credits. We'll open them as spots free up — or add your own key in the Engine box to generate now.",
  used_up: "You've used your included credits. Join the waitlist for more — or add your own key in the Engine box to keep going.",
  pool_empty: "Songflow's included credits are paused right now. Add your own key in the Engine box, or try again later."
};
