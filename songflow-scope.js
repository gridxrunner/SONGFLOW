/* Songflow project scope. Projects live in this browser, filed under the signed-in account:
   signed out you see only signed-out projects; signed in, only that account's. The account is
   read synchronously from Supabase's saved session so the right list loads before anything
   renders; signing in or out reloads the page into the other list (songflow-cloud.js).
   The first sign-in in a browser takes over the projects made there while signed out. */
(function () {
  var REF = "stwlawvkrcoxosuimrzh";
  var uid = null;
  try {
    var raw = localStorage.getItem("sb-" + REF + "-auth-token");
    if (raw && raw.indexOf("base64-") === 0) raw = atob(raw.slice(7));
    var s = raw ? JSON.parse(raw) : null;
    var u = s && (s.user || (s.currentSession && s.currentSession.user));
    uid = (u && u.id) || null;
  } catch (e) { uid = null; }
  var docsKey = uid ? "ams.lyrics.docs@" + uid : "ams.lyrics.docs";
  var textKey = uid ? "ams.lyrics@" + uid : "ams.lyrics";
  if (uid) {
    try {
      if (!localStorage.getItem(docsKey) && localStorage.getItem("ams.lyrics.docs")) {
        localStorage.setItem(docsKey, localStorage.getItem("ams.lyrics.docs"));
        localStorage.removeItem("ams.lyrics.docs");
        if (localStorage.getItem("ams.lyrics") !== null) {
          localStorage.setItem(textKey, localStorage.getItem("ams.lyrics"));
          localStorage.removeItem("ams.lyrics");
        }
      }
    } catch (e) { /* storage blocked: fall back to whatever is readable */ }
  }
  window.SF_SCOPE = { uid: uid, docsKey: docsKey, textKey: textKey };
})();
