/* Songflow bug intake — Cloudflare Pages Function (served at /api/bug).
 *
 * The in-app Report bug button POSTs here. Each report becomes a row in the PRIVATE Supabase
 * table public.bug_reports (no browser can read it); a Claude Code session working on this repo
 * picks the queue up from there — see CLAUDE.md. Uses the same SUPABASE_URL /
 * SUPABASE_SERVICE_KEY environment variables as /api/generate, so there is nothing new to set.
 */

const MAX_TEXT = 4000, MAX_CTX = 12000, PER_VISITOR_PER_10MIN = 6;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY)
    return json({ error: "Bug intake isn't configured on the server." }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request." }, 400); }
  const text = String(body.text || "").trim().slice(0, MAX_TEXT);
  if (text.length < 3) return json({ error: "Describe what happened first." }, 400);
  let context = (body.context && typeof body.context === "object" && !Array.isArray(body.context)) ? body.context : {};
  const ctxStr = JSON.stringify(context);
  if (ctxStr.length > MAX_CTX) context = { truncated: true, raw: ctxStr.slice(0, MAX_CTX) };

  const sb = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json"
  };

  // flood guard: a handful of reports per visitor per 10 minutes. The IP is never stored —
  // only a salted hash, so repeat senders can be throttled without keeping who they are.
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha256hex(ip + "|songflow-bug-intake")).slice(0, 32) : null;
  if (ipHash) {
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/bug_reports?select=id&limit=1&ip_hash=eq.${ipHash}&created_at=gte.${encodeURIComponent(since)}`,
        { headers: { ...sb, Prefer: "count=exact" } });
      const n = parseInt(((r.headers.get("content-range") || "").split("/")[1]) || "0", 10);
      if (n >= PER_VISITOR_PER_10MIN)
        return json({ error: "Thanks — you've sent several reports in the last few minutes. Try again shortly." }, 429);
    } catch (e) { /* best-effort: never block a report because the guard failed */ }
  }

  // a signed-in tester's session identifies them, so a fix can be followed up with them
  let reporterEmail = null;
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    try {
      const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: auth, apikey: env.SUPABASE_SERVICE_KEY }
      });
      if (who.ok) { const u = await who.json(); reporterEmail = (u && u.email) || null; }
    } catch (e) { /* anonymous report */ }
  }

  const row = {
    text,
    context,
    version: String(context.version || "").slice(0, 20) || null,
    page: String(context.url || "").slice(0, 300) || null,
    reporter_email: reporterEmail,
    ip_hash: ipHash
  };
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/bug_reports`, {
      method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(row)
    });
    if (!r.ok) return json({ error: `Couldn't save the report (${r.status}).` }, 502);
    const out = await r.json();
    return json({ ok: true, id: (out && out[0] && out[0].id) || null });
  } catch (e) {
    return json({ error: "Couldn't reach the report store." }, 503);
  }
}
