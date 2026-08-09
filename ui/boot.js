/**
 * ui/boot.js — one job, done before the first paint.
 *
 * A classic script in <head> (not a module, so it is not deferred) that sets the
 * accent from the last known choice. Without it the app paints the default blue
 * for a frame and then flips to whatever the user picked, which reads as a bug.
 * It cannot be an inline script: the server's CSP is `default-src 'self'`, with
 * no 'unsafe-inline' for scripts — deliberately.
 */
(function () {
  try {
    var stored = localStorage.getItem('zelos.accent');
    if (typeof stored === 'string' && /^#[0-9a-fA-F]{6}$/.test(stored)) {
      document.documentElement.style.setProperty('--accent', stored.toLowerCase());
    }
  } catch (e) {
    /* storage disabled; the stylesheet default stands */
  }
}());
