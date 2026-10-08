/* Songflow cloud — sign-in (Supabase): Google, or a magic link by email, plus the account menu.
   Projects are not synced to the cloud: they stay in this browser, filed under the signed-in
   account (songflow-scope.js), so signing in or out reloads the page into that account's list.
   The publishable (anon) key is the PUBLIC browser key by design — safe to ship in a static app.
   RLS on the database is what protects the data, not the secrecy of this key. */
(function () {
  const SB_URL = "https://stwlawvkrcoxosuimrzh.supabase.co";
  const SB_KEY = "sb_publishable_3lLEwFTKZGyiEBzFQ_4BAQ_k31XYeub";
  const $ = id => document.getElementById(id);
  const note = (t, c) => { const n = $("authNote"); if (n) { n.style.color = c || ""; n.textContent = t; } };
  const toast = m => { if (typeof window.toast === "function") window.toast(m); };
  let sb = null, user = null, tries = 0, accessChecked = false;

  function init() {
    if (!window.supabase || !window.supabase.createClient) {        // wait for the CDN script
      if (tries++ < 50) return setTimeout(init, 150);
      return;                                                       // CDN blocked — app still works offline, just no cloud
    }
    sb = window.supabase.createClient(SB_URL, SB_KEY);
    window.SBClient = sb;
    sb.auth.getSession().then(({ data }) => { user = data.session && data.session.user; render(); });
    showProviders();
    sb.auth.onAuthStateChange((evt, session) => {
      user = session && session.user; render();
      if (evt === "SIGNED_IN") { closePanel(); toast("Signed in as " + (user && user.email)); }
      if (scopeChanged()) return;                                   // reloading into the other project list
      window.dispatchEvent(new CustomEvent("sf-auth", { detail: { user } }));
      // decide this person's tester spot as soon as they're signed in, on any page (the studio's
      // credit meter does its own check)
      if (user && !accessChecked && typeof window.refreshCredits !== "function") { accessChecked = true; checkAccess(); }
    });
    wire();
  }

  /* projects are filed per account: when the signed-in account no longer matches the list this page
     loaded, save and reload so the right list shows (songflow-scope.js picks it). The clean URL drops
     any one-time sign-in code left in the address. */
  function scopeChanged() {
    const S = window.SF_SCOPE;
    if (!S) return false;                                           // page without project lists
    const now = (user && user.id) || null;
    if (now === (S.uid || null)) return false;
    try {                                                           // never loop if the saved session can't be read back
      const last = +sessionStorage.getItem("sf.scopeReload") || 0;
      if (Date.now() - last < 8000) return false;
      sessionStorage.setItem("sf.scopeReload", String(Date.now()));
    } catch (e) { return false; }
    try { if (typeof window.autosaveNow === "function") window.autosaveNow(); } catch (e) {}
    location.replace(location.origin + location.pathname);
    return true;
  }

  function shortEmail(e) { e = e || ""; return e.length > 22 ? e.slice(0, 20) + "…" : e; }
  function render() {
    const b = $("authBtn"); if (!b) return;
    if (user) { b.textContent = "\u{1F464} " + shortEmail(user.email) + " ▾"; b.title = "Your account"; }
    else { b.textContent = "Sign in"; b.title = "Sign in to use your included AI credits (Google or an email link — no password)"; closeMenu(); }
  }

  function openPanel() { const p = $("authPanel"); if (p) { p.style.display = "flex"; note(""); setTimeout(() => $("authEmail") && $("authEmail").focus(), 30); } }
  function closePanel() { const p = $("authPanel"); if (p) p.style.display = "none"; }

  async function sendLink() {
    if (!sb) { note("Cloud isn't loaded — check your connection.", "var(--danger)"); return; }
    const email = ($("authEmail") && $("authEmail").value || "").trim();
    if (!/.+@.+\..+/.test(email)) { note("Enter a valid email address.", "var(--danger)"); return; }
    note("Sending…");
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { note("Couldn't send: " + error.message, "var(--danger)"); return; }
    note("✓ Check your email for the one-tap sign-in link. You can close this window.", "var(--accent2)");
  }
  // the Google button appears only once Google is switched on in Supabase (Authentication > Providers)
  async function showProviders() {
    try {
      const r = await fetch(SB_URL + "/auth/v1/settings", { headers: { apikey: SB_KEY } });
      const s = await r.json();
      const on = !!(s && s.external && s.external.google);
      if ($("authGoogle")) $("authGoogle").style.display = on ? "flex" : "none";
      if ($("authOr")) $("authOr").style.display = on ? "block" : "none";
    } catch (e) { /* settings unreachable: email sign-in still works */ }
  }
  async function signInGoogle() {
    if (!sb) { note("Cloud isn't loaded — check your connection.", "var(--danger)"); return; }
    try { if (typeof window.autosaveNow === "function") window.autosaveNow(); } catch (e) {}   // the page goes to Google and comes back
    note("Opening Google…");
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    if (error) note("Couldn't start Google sign-in: " + error.message, "var(--danger)");
  }
  async function doSignOut() {
    if (!sb) return;
    try { if (typeof window.autosaveNow === "function") window.autosaveNow(); } catch (e) {}
    await sb.auth.signOut();
    toast("Signed out.");
  }

  /* ---- PREVIEW MODE (admin only): the unpublished `preview` build, served by the live site at /preview/
     so it keeps this window's sign-in and projects (functions/preview/[[path]].js). /api/preview gives
     the admin's browser the pass; leaving needs none. ---- */
  const IN_PREVIEW = /^\/preview(\/|$)/.test(location.pathname);
  function previewPath(on) {
    const p = location.pathname.replace(/^\/preview(?=\/|$)/, "") || "/";
    return (on ? "/preview" + p : p) + location.search + location.hash;
  }
  async function setPreview(on) {
    try { if (typeof window.autosaveNow === "function") window.autosaveNow(); } catch (e) {}
    const headers = { "content-type": "application/json" };
    if (on && sb) { const { data } = await sb.auth.getSession(); const tok = data && data.session && data.session.access_token; if (tok) headers.Authorization = "Bearer " + tok; }
    try {
      const r = await fetch("/api/preview", { method: "POST", headers, body: JSON.stringify({ on }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || "Couldn't switch preview mode."); return false; }
    } catch (e) { toast("Couldn't reach Songflow — check your connection."); return false; }
    location.href = previewPath(on);
    return true;
  }
  function previewBadge() {
    if (!IN_PREVIEW || $("sfPreviewBadge") || !document.body) return;
    const b = el("div", "position:fixed;left:12px;bottom:58px;z-index:10002;display:flex;align-items:center;gap:8px;padding:4px 4px 4px 11px;border-radius:999px;background:#ffb020;color:#0c0d12;font:800 11px/1 Inter,system-ui,sans-serif;letter-spacing:.3px;box-shadow:0 6px 20px rgba(0,0,0,.45)");
    b.id = "sfPreviewBadge"; b.title = "You're on the unpublished version. Testers still see the published one.";
    const x = el("button", "border:0;border-radius:999px;padding:5px 10px;background:#0c0d12;color:#ffb020;font:800 10.5px/1 Inter,system-ui,sans-serif;cursor:pointer", "Exit preview");
    x.onclick = () => { x.disabled = true; setPreview(false).then(ok => { if (!ok) x.disabled = false; }); };
    b.append(el("span", "", "PREVIEW · unpublished"), x);
    document.body.append(b);
  }

  /* tester access: spot / credits / waitlist (functions/api/access.js) */
  async function checkAccess(action) {
    try {
      const { data } = await sb.auth.getSession();
      const tok = data && data.session && data.session.access_token;
      if (!tok) return null;
      const r = await fetch("/api/access", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(action ? { action } : {}) });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  /* ---- account menu: who you are, your credits, admin, sign out ---- */
  function el(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function closeMenu() { const m = $("acctMenu"); if (m) m.remove(); document.removeEventListener("mousedown", onOutside, true); document.removeEventListener("keydown", onEsc, true); }
  function onOutside(e) { const m = $("acctMenu"), b = $("authBtn"); if (m && !m.contains(e.target) && !(b && b.contains(e.target))) closeMenu(); }
  function onEsc(e) { if (e.key === "Escape") closeMenu(); }
  function fillCredits(box, adminSlot, d) {
    box.textContent = "";
    const joinBtn = label => { const j = el("button", "margin-top:8px;width:100%;padding:7px;border-radius:8px;border:0;background:#ffd43b;color:#0c0d12;font-weight:800;cursor:pointer", label);
      j.onclick = async () => { j.disabled = true; j.textContent = "Joining…"; const n = await checkAccess("join"); fillCredits(box, adminSlot, n);
        if (typeof window.refreshCredits === "function") window.refreshCredits(); }; return j; };
    if (!d) { box.append("Couldn't check your credits right now."); return; }
    if (d.status === "active") box.append(el("span", "", "Included AI credits: "), el("b", "color:var(--accent2)", "$" + (Number(d.balance) || 0).toFixed(2)));
    else if (d.status === "waitlist") box.append(`You're on the waitlist${d.position ? " (#" + d.position + ")" : ""}. We'll open your included credits as spots free up.`);
    else if (d.status === "used_up") { box.append("You've used your included credits."); box.append(joinBtn("Join the waitlist for more")); }
    else { box.append("Tester spots are full right now."); box.append(joinBtn("Join the waitlist")); }
    adminSlot.textContent = "";
    if (d.admin) {
      const a = el("a", "display:block;color:var(--accent2);font-weight:700;text-decoration:none;margin-bottom:10px", "Tester access & waitlist →"); a.href = "admin"; adminSlot.append(a);
      // preview mode: just for the admin; testers keep the published version
      const row = el("label", "display:flex;align-items:flex-start;gap:8px;margin:0 0 10px;padding:8px 9px;border-radius:9px;border:1px solid " + (IN_PREVIEW ? "#ffb020" : "var(--line)") + ";cursor:pointer");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = IN_PREVIEW; cb.style.cssText = "accent-color:#ffb020;margin:2px 0 0;cursor:pointer";
      cb.onchange = () => { cb.disabled = true; setPreview(cb.checked).then(ok => { if (!ok) { cb.disabled = false; cb.checked = IN_PREVIEW; } }); };
      const tx = el("span", "display:flex;flex-direction:column;gap:2px");
      tx.append(el("b", "font-size:12px", "Preview mode"), el("span", "font-size:11px;color:var(--mut)", "Try the unpublished version in this window. Only you see it."));
      row.append(cb, tx); adminSlot.append(row);
    }
  }
  function toggleMenu() {
    if ($("acctMenu")) { closeMenu(); return; }
    const b = $("authBtn"); if (!b || !user) return;
    const r = b.getBoundingClientRect();
    const m = el("div", "position:fixed;z-index:10001;width:260px;max-width:calc(100vw - 16px);box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-size:12.5px;line-height:1.45;color:var(--txt)");
    m.id = "acctMenu"; m.setAttribute("role", "menu");
    m.style.top = Math.round(r.bottom + 6) + "px";
    m.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
    const credits = el("div", "padding:9px 10px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);margin-bottom:10px", "Checking your credits…");
    const adminSlot = el("div");
    const out = el("button", "width:100%;padding:8px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);color:var(--txt);font-weight:700;cursor:pointer", "Sign out");
    out.onclick = () => { closeMenu(); doSignOut(); };
    m.append(el("div", "font-size:11px;color:var(--mut)", "Signed in as"), el("div", "font-weight:700;margin:2px 0 10px;word-break:break-all", user.email || ""),
      credits, adminSlot, out, el("div", "font-size:10.5px;color:var(--mut);margin-top:7px", "Your projects stay saved in this browser for when you sign back in."));
    document.body.append(m);
    setTimeout(() => { document.addEventListener("mousedown", onOutside, true); document.addEventListener("keydown", onEsc, true); }, 0);
    checkAccess().then(d => { if ($("acctMenu") === m) fillCredits(credits, adminSlot, d); });
  }

  function wire() {
    const b = $("authBtn"); if (b) b.onclick = () => (user ? toggleMenu() : openPanel());
    if ($("authSend")) $("authSend").onclick = sendLink;
    if ($("authGoogle")) $("authGoogle").onclick = signInGoogle;
    if ($("authClose")) $("authClose").onclick = closePanel;
    if ($("authEmail")) $("authEmail").onkeydown = e => { if (e.key === "Enter") sendLink(); };
    const p = $("authPanel"); if (p) p.addEventListener("click", e => { if (e.target === p) closePanel(); });
  }

  if (document.body) previewBadge(); else document.addEventListener("DOMContentLoaded", previewBadge);
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
