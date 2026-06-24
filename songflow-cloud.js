/* Songflow cloud — magic-link auth (Supabase). Per-user project sync is layered on next.
   The publishable (anon) key is the PUBLIC browser key by design — safe to ship in a static app.
   RLS on the database is what protects the data, not the secrecy of this key. */
(function () {
  const SB_URL = "https://stwlawvkrcoxosuimrzh.supabase.co";
  const SB_KEY = "sb_publishable_3lLEwFTKZGyiEBzFQ_4BAQ_k31XYeub";
  const $ = id => document.getElementById(id);
  const note = (t, c) => { const n = $("authNote"); if (n) { n.style.color = c || ""; n.textContent = t; } };
  const toast = m => { if (typeof window.toast === "function") window.toast(m); };
  let sb = null, user = null, tries = 0;

  function init() {
    if (!window.supabase || !window.supabase.createClient) {        // wait for the CDN script
      if (tries++ < 50) return setTimeout(init, 150);
      return;                                                       // CDN blocked — app still works offline, just no cloud
    }
    sb = window.supabase.createClient(SB_URL, SB_KEY);
    window.SBClient = sb;                                           // expose for the upcoming sync layer
    sb.auth.getSession().then(({ data }) => { user = data.session && data.session.user; render(); });
    sb.auth.onAuthStateChange((evt, session) => {
      user = session && session.user; render();
      if (evt === "SIGNED_IN") { closePanel(); toast("Signed in as " + (user && user.email)); }
      window.dispatchEvent(new CustomEvent("sf-auth", { detail: { user } }));   // sync layer listens for this
    });
    wire();
  }

  function shortEmail(e) { e = e || ""; return e.length > 20 ? e.slice(0, 18) + "…" : e; }
  function render() {
    const b = $("authBtn"); if (!b) return;
    if (user) { b.innerHTML = "&#128100; " + shortEmail(user.email); b.title = "Signed in — click to sign out"; }
    else { b.textContent = "Sign in"; b.title = "Sign in to save your projects to the cloud (magic link — no password)"; }
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
  async function doSignOut() { if (sb) { await sb.auth.signOut(); toast("Signed out."); } }

  function wire() {
    const b = $("authBtn"); if (b) b.onclick = () => (user ? doSignOut() : openPanel());
    if ($("authSend")) $("authSend").onclick = sendLink;
    if ($("authClose")) $("authClose").onclick = closePanel;
    if ($("authEmail")) $("authEmail").onkeydown = e => { if (e.key === "Enter") sendLink(); };
    const p = $("authPanel"); if (p) p.addEventListener("click", e => { if (e.target === p) closePanel(); });
  }

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
