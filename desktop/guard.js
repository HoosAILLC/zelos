/**
 * desktop/guard.js — where the shell is allowed to go.
 *
 * A BrowserWindow is a browser. Everything Zelos reads is written by other
 * people — a link in a message, a URL on a calendar event, a string a model
 * echoed back — and any of it can end up as an `<a href>` in the page. So the
 * shell's window is treated as a fixture pointed at exactly one address: the
 * local board. Nothing else may load *inside* it, ever.
 *
 * Three outcomes, and no fourth:
 *
 *   internal  the board itself — the one origin the shell serves. Allowed.
 *   external  an ordinary web or mail link. Refused here and handed to the
 *             system browser, where the user's own defences live and where a
 *             page cannot see this app's session token.
 *   block     everything else. `file:` would turn a link in a stranger's email
 *             into a local file read; `javascript:` and `data:` would run code
 *             in the board's origin; custom schemes (`ms-msdt:`, `zoommtg:`)
 *             hand an argument string to another program on this machine.
 *             None of those are worth the convenience.
 *
 * This module imports nothing from Electron on purpose: the decision is pure,
 * so it can be tested exhaustively without a packaged app.
 */

/**
 * Hostnames that mean "this machine" — matching core/server.mjs. `URL.hostname`
 * keeps the brackets on an IPv6 literal, so both spellings are listed.
 */
export const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1', '[::1]']));

/** The only schemes that may be handed to the system browser. */
export const EXTERNAL_SCHEMES = Object.freeze(new Set(['http:', 'https:', 'mailto:']));

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

/**
 * Classify a navigation target.
 *
 * `port` is the port the local server actually bound. It is required: with no
 * port there is no such thing as "our own origin", so nothing is internal and
 * the shell fails closed.
 *
 * Returns `{action, url, reason}`. `url` is the parsed, normalised href for the
 * two allowed outcomes and the raw input for a block, so a log line shows what
 * was actually asked for.
 */
export function classifyTarget(raw, { port } = {}) {
  if (typeof raw !== 'string' || raw === '') {
    return { action: 'block', url: String(raw ?? ''), reason: 'empty navigation target' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { action: 'block', url: raw, reason: 'not a URL the shell can parse' };
  }

  const ourPort = Number(port);
  const isOurs =
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    Number.isInteger(ourPort) &&
    ourPort > 0 &&
    portOf(url) === ourPort;

  if (isOurs) return { action: 'internal', url: url.href, reason: 'the board itself' };
  if (EXTERNAL_SCHEMES.has(url.protocol)) {
    return { action: 'external', url: url.href, reason: 'not the board — opening it in your browser instead' };
  }
  return { action: 'block', url: raw, reason: `${url.protocol} is not a scheme the shell will open` };
}

function portOf(url) {
  if (url.port !== '') return Number(url.port);
  return DEFAULT_PORTS[url.protocol] ?? -1;
}

/**
 * Wire the guard onto one webContents.
 *
 * `deps` carries the two effects this needs — opening the system browser and
 * logging — so the wiring itself stays testable. `getPort` is read at event
 * time rather than captured, because the window is created before the server
 * has finished binding on a first run.
 */
export function guardWebContents(contents, { getPort, openExternal, logger }) {
  const decide = (raw) => classifyTarget(raw, { port: getPort() });

  const handleNavigation = (event, raw) => {
    const verdict = decide(raw);
    if (verdict.action === 'internal') return;
    event.preventDefault();
    if (verdict.action === 'external') {
      logger.info('desktop: opening a link in the system browser', { url: verdict.url });
      openExternal(verdict.url);
      return;
    }
    logger.warn('desktop: refused a navigation', { url: verdict.url, reason: verdict.reason });
  };

  contents.on('will-navigate', handleNavigation);
  // A 302 to another origin is a navigation the page never announced.
  contents.on('will-redirect', handleNavigation);

  contents.setWindowOpenHandler(({ url: raw }) => {
    const verdict = decide(raw);
    if (verdict.action === 'external') {
      logger.info('desktop: opening a new-window link in the system browser', { url: verdict.url });
      openExternal(verdict.url);
    } else {
      // The board itself is refused here too — not routed into the window that
      // is already open, which is what used to happen. The board has no popups
      // of its own, so a new-window request for its own origin can only be a
      // link somebody else wrote: every item link renders target=_blank, and a
      // feed's `<link>/?t=x</link>` resolves against the board's address into
      // exactly this origin. Loading that in the main window handed the page a
      // `?t=` it stored in place of the live session token, and every call
      // 401ed until "Reload board". Nothing is lost by denying it: the board's
      // own same-window navigations are hash routes, and those never get here.
      const reason = verdict.action === 'internal' ? 'the board opens no popups of its own' : verdict.reason;
      logger.warn('desktop: refused a new window', { url: verdict.url, reason });
    }
    return { action: 'deny' };
  });

  // `webviewTag` is off, so this cannot fire — but a <webview> is a whole
  // second renderer with its own preferences, and "cannot" is not "does not".
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('desktop: refused a <webview>');
  });
}
