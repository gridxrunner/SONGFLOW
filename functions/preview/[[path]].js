/* /preview/* — the unpublished version, for the admin's browser only. Serves the `preview` branch's
 * build (PREVIEW_ORIGIN) from THIS origin, so it shares the live site's sign-in and saved projects.
 * Pages use relative paths, so everything they load stays under /preview/; /api/* calls go to the live
 * server functions. Without a valid preview pass, you get the published version of the same page. */
import { hasPreview, PREVIEW_ORIGIN } from "../_lib/preview.js";

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/preview/, "") || "/";
  if (!(await hasPreview(request, env))) return Response.redirect(new URL(rest + url.search, url.origin).toString(), 302);
  if (url.pathname === "/preview") return Response.redirect(new URL("/preview/" + url.search, url.origin).toString(), 302);   // relative links need the slash
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const up = await fetch(`${PREVIEW_ORIGIN}/${path}${url.search}`, {
    method: request.method, redirect: "manual",
    headers: { accept: request.headers.get("accept") || "*/*" }
  });
  if (up.status >= 300 && up.status < 400) {                 // the build's pretty-URL redirects (studio.html → studio) stay inside /preview
    const to = new URL(up.headers.get("location") || "/", PREVIEW_ORIGIN);
    return Response.redirect(new URL("/preview" + to.pathname + to.search, url.origin).toString(), up.status === 301 || up.status === 308 ? 308 : 302);
  }
  const h = new Headers(up.headers);
  h.set("cache-control", "no-store");                        // always the latest preview build
  h.set("x-robots-tag", "noindex");
  h.delete("set-cookie");
  return new Response(up.body, { status: up.status, headers: h });
}
