// Applied before first paint to avoid a flash of the wrong theme.
// Reads the persisted preference and sets data-theme on <html>; styles.css
// reacts to both this attribute and prefers-color-scheme for "system" mode.
//
// Kept as its own tiny synchronous, blocking <script src> (loaded before
// styles.css in index.html's <head>, deliberately without defer/async) so
// it runs before first paint — the same timing an inline script would have
// had, but externalized so the page's Content-Security-Policy can be a
// plain `script-src 'self'` with no 'unsafe-inline' (see public/_headers).
(function () {
  try {
    var stored = localStorage.getItem("submail:theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {
    // localStorage unavailable (private mode, etc.) — fall back to system.
  }
})();
