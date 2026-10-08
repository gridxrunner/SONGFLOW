/* POST /api/preview {on:true}  — admins only: get the preview pass (cookie) for this browser.
 * POST /api/preview {on:false} — anyone: drop it (leaving preview needs no permission).
 * GET  /api/preview            — is preview mode on in this browser? (the cookie is HttpOnly) */
import { json, configured, whoAmI, isAdmin } from "../_lib/sb.js";
import { previewToken, hasPreview, setPreviewCookie, clearPreviewCookie, PREVIEW_MAX_AGE } from "../_lib/preview.js";

const withCookie = (obj, cookie) =>
  new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie } });

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  if (body.on === false) return withCookie({ ok: true, on: false }, clearPreviewCookie());
  if (!configured(env)) return json({ error: "Preview mode isn't set up on this server." }, 503);
  const user = await whoAmI(request, env);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (!(await isAdmin(env, user.email))) return json({ error: "Preview mode is only for Songflow's admin." }, 403);
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_MAX_AGE;
  return withCookie({ ok: true, on: true }, setPreviewCookie(await previewToken(env, user.id, exp)));
}

export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify({ on: await hasPreview(request, env) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
