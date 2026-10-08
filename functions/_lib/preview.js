/* Preview mode: the admin can run the UNPUBLISHED version (the `preview` branch, which Cloudflare
 * builds at https://preview.songflow.pages.dev) inside the live site at /preview/, so it shares this
 * origin's sign-in and the projects saved in the browser. /api/preview hands out a signed, HttpOnly
 * cookie to admins only; /preview/* (functions/preview/[[path]].js) checks it on every request. */

export const PREVIEW_COOKIE = "sf_preview";
export const PREVIEW_ORIGIN = "https://preview.songflow.pages.dev";
const DAY = 86400;
export const PREVIEW_MAX_AGE = 30 * DAY;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// the signing key is derived from the service key (never sent to a browser), kept apart by a prefix
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("sf-preview-cookie:" + (env.SUPABASE_SERVICE_KEY || "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

export async function previewToken(env, uid, exp) { return `${uid}.${exp}.${await hmac(env, `${uid}.${exp}`)}`; }

function readCookie(request, name) {
  const all = request.headers.get("cookie") || "";
  for (const part of all.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* true when this browser holds a valid, unexpired preview pass */
export async function hasPreview(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return false;
  const v = readCookie(request, PREVIEW_COOKIE); if (!v) return false;
  const [uid, exp, sig] = v.split(".");
  if (!uid || !exp || !sig || !(+exp > Date.now() / 1000)) return false;
  const want = await hmac(env, `${uid}.${exp}`);
  if (want.length !== sig.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);   // constant-time compare
  return d === 0;
}

export const setPreviewCookie = token =>
  `${PREVIEW_COOKIE}=${token}; Path=/; Max-Age=${PREVIEW_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
export const clearPreviewCookie = () => `${PREVIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
