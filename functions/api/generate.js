/* Songflow generation proxy — Cloudflare Pages Function (served at /api/generate).
 *
 * WHY THIS EXISTS: testers must be able to generate lyrics without owning an API key, and the
 * founder's OpenRouter key must never reach a browser (a browser-exposed key is drainable by
 * anyone who opens devtools). So the key lives ONLY in this server-side function, and every
 * request is metered against the signed-in user's credit balance.
 *
 * REQUIRED environment variables (set in the Cloudflare Pages dashboard, never in the repo):
 *   OPENROUTER_KEY        - the OpenRouter API key that pays for generations
 *   SUPABASE_URL          - e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  - the service_role key (server-only; bypasses RLS to move the ledger)
 * Optional:
 *   SF_MODEL              - model id override (default deepseek/deepseek-v4.1-flash; falls back to
 *                           deepseek/deepseek-v4-flash if it errors or returns nothing)
 *   SF_MAX_TOKENS         - hard per-request output cap (default 2000)
 */

const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";   // newest DeepSeek Flash (Sep 2026)
const FALLBACK_MODEL = "deepseek/deepseek-v4-flash";    // the previous default, used only if the newer one fails
const HARD_TOKEN_CAP = 2000;
// Conservative fallback pricing (USD per token) used ONLY if OpenRouter doesn't report a cost.
// Deliberately over-estimates so a pricing surprise can never silently overspend the pool.
const FALLBACK_IN = 0.60 / 1e6, FALLBACK_OUT = 2.40 / 1e6;   // 2x V4.1 Flash list price

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  // ---- config sanity: fail loudly here rather than mysteriously downstream ----
  if (!env.OPENROUTER_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY)
    return json({ error: "Server not configured — missing OPENROUTER_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY." }, 500);

  // ---- who is asking? (the whole point of login: we must know WHO to meter) ----
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "Sign in to use your included credits." }, 401);

  let userId, email;
  try {
    const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_SERVICE_KEY }
    });
    if (!who.ok) return json({ error: "Your session expired — sign in again." }, 401);
    const u = await who.json();
    userId = u && u.id; email = (u && u.email) || "";
    if (!userId) return json({ error: "Your session expired — sign in again." }, 401);
  } catch (e) {
    return json({ error: "Couldn't verify your session. Try again." }, 503);
  }

  // ---- body ----
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request." }, 400); }
  const system = String(body.system || ""), user = String(body.user || "");
  if (!user) return json({ error: "Nothing to generate." }, 400);
  const cap = Math.min(parseInt(env.SF_MAX_TOKENS || HARD_TOKEN_CAP, 10) || HARD_TOKEN_CAP, HARD_TOKEN_CAP);
  const maxTokens = Math.max(64, Math.min(parseInt(body.maxTokens, 10) || 600, cap));

  const sbHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json"
  };

  // ---- allowance check BEFORE spending the founder's money ----
  // remaining = min(this user's cap - what they've spent, the shared pool balance).
  // The pool is the hard ceiling: total spend can never exceed what was funded,
  // no matter how many accounts sign up.
  let balance = 0;
  try {
    // make sure the user has a row (in case the signup trigger didn't fire)
    await fetch(`${env.SUPABASE_URL}/rest/v1/credits`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ user_id: userId, email })
    });
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/credit_remaining`, {
      method: "POST", headers: sbHeaders, body: JSON.stringify({ p_user: userId })
    });
    if (!r.ok) return json({ error: "Couldn't read your credit balance. Try again." }, 503);
    balance = Number(await r.json()) || 0;
  } catch (e) {
    return json({ error: "Couldn't read your credit balance. Try again." }, 503);
  }
  if (balance <= 0)
    return json({ error: "You've used all your Songflow credits. Add your own OpenRouter key in the Engine box to keep generating.", balance: 0 }, 402);

  // ---- generate: the current model first; if it errors or comes back empty, the previous one ----
  const models = [...new Set([env.SF_MODEL || DEFAULT_MODEL, FALLBACK_MODEL])];
  let text = "", used = null, cost = 0, lastErr = "Couldn't reach the model. Try again.";
  for (const model of models) {
    let data;
    try {
      const or = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_KEY}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://songflow.pages.dev",
          "X-Title": "Songflow"
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: maxTokens,
          temperature: 0.9,
          usage: { include: true }              // ask OpenRouter to report real cost so metering is exact
        })
      });
      const raw = await or.text();
      if (!or.ok) { lastErr = `Generation failed (${or.status}). ${raw.slice(0, 160)}`; continue; }
      data = JSON.parse(raw);
    } catch (e) {
      lastErr = "Couldn't reach the model. Try again.";
      continue;
    }
    // meter every billed call -- an empty answer was still paid for. Prefer OpenRouter's reported
    // cost, else a conservative token estimate.
    const u = data.usage || {};
    let c = Number(u.cost);
    if (!isFinite(c) || c < 0)
      c = (Number(u.prompt_tokens) || 0) * FALLBACK_IN + (Number(u.completion_tokens) || 0) * FALLBACK_OUT;
    cost += c;
    const choice = (data.choices && data.choices[0]) || {};
    text = ((choice.message && choice.message.content) || "").trim();
    if (text) { used = model; break; }
    lastErr = `The model returned no text (finish_reason: ${choice.finish_reason || "none"}).`;
  }

  // Decrement AFTER generating. If this write fails we still return the lyrics -- the user
  // already got value, and a tiny accounting leak beats a broken feature.
  let newBalance = balance - cost;
  if (cost > 0) {
    try {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/spend_credit`, {
        method: "POST", headers: sbHeaders,
        body: JSON.stringify({ p_user: userId, p_amount: cost })
      });
      if (r.ok) { const v = await r.json(); if (v != null && isFinite(Number(v))) newBalance = Number(v); }
    } catch (e) { /* keep the estimate */ }
  }
  if (!text) return json({ error: lastErr, balance: Math.max(0, newBalance) }, 502);
  return json({ text, balance: Math.max(0, newBalance), cost, model: used });
}
