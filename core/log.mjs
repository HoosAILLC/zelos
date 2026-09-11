/**
 * core/log.mjs — logging with credential redaction.
 *
 * Zelos handles mail passwords and API keys. A log line is the easiest place
 * in a program for one of those to escape, so redaction happens here, on every
 * value, rather than being remembered at each call site.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Patterns that mean "this is a secret" regardless of what it was called. */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,               // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,           // Anthropic
  /\bgsk_[A-Za-z0-9]{20,}/g,                // Groq
  /\bAIza[0-9A-Za-z_-]{20,}/g,              // Google
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{16,}/g,           // Google OAuth client secret
  /\bya29\.[A-Za-z0-9._-]{16,}/g,          // Google OAuth access token
  // Zelos's own AI-access token (core/ai-access.mjs). It is the credential that
  // hands somebody's mail to another program, so it is redacted by shape as
  // well as by key name — a log line that interpolates one into a sentence
  // never reaches the `token`/`value` key check.
  /\bzlt_[a-z]{1,8}_[0-9a-f]{4,16}_[A-Za-z0-9_-]{22,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}=*/gi,
];

/** Keys whose *value* is always redacted, whatever it looks like. */
const SECRET_KEYS = new Set([
  'pass', 'password', 'passwd', 'apppassword', 'apikey', 'key', 'token', 'secret',
  'authorization', 'xapikey', 'sessiontoken', 'value', 'credentials',
  'accesstoken', 'refreshtoken', 'clientsecret', 'devicecode',
]);

const normalizedKey = key => key.toLowerCase().replace(/[-_\s]/g, '');
const URL_TEXT = /\b(?:https?|webcal):\/\/[^\s<>"'\\\x00-\x1f]+/gi;
// Error strings can contain JSON or form fields instead of structured metadata.
// Do not guess that an arbitrary UUID or a 16-letter word is a password: the
// field name supplies that evidence. Quoted values can contain spaces/escapes.
const SECRET_ASSIGNMENT = /((?:^|[^\w])['"]?(?:pass(?:word|wd)?|app[-_ ]?password|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|device[-_ ]?code|session[-_ ]?token|x-api-key|authorization|credentials|secret|token)['"]?\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;&}\]]+)/gi;

/** A destination suitable for diagnostics: never a private path or URL grant. */
export function diagnosticAddress(raw) {
  try {
    const url = new URL(String(raw).replace(/^webcal:/i, 'https:'));
    return /^https?:$/.test(url.protocol) ? `${url.protocol}//${url.host}` : 'configured address';
  } catch { return 'configured address'; }
}

function withUrlPunctuation(raw, transform) {
  // Prose such as "(via host:port)" includes punctuation in URL_TEXT's token.
  // Separate unmatched closing delimiters, while keeping IPv6 brackets and
  // balanced parentheses in a URL path. Count once so long input stays linear.
  const balance = { ')': 0, ']': 0, '}': 0 };
  const opening = { '(': ')', '[': ']', '{': '}' };
  for (const char of raw) {
    if (Object.hasOwn(balance, char)) balance[char] += 1;
    else if (opening[char]) balance[opening[char]] -= 1;
  }
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1];
    if (/[.,;!?]/.test(char)) end -= 1;
    else if (balance[char] > 0) { balance[char] -= 1; end -= 1; }
    else break;
  }
  return transform(raw.slice(0, end)) + raw.slice(end);
}

function redactUrl(raw) {
  try {
    const url = new URL(raw.replace(/^webcal:/i, 'https:'));
    const secretQuery = [...url.searchParams.keys()].some(key =>
      SECRET_KEYS.has(normalizedKey(key)) || /^(?:auth|credential|signature|sig|code)$/i.test(key));
    // Subscription links are bearer grants even when they have no password
    // field. Preserve normal source URLs: item history also uses redact().
    if (url.username || url.password || secretQuery || /(?:\/private[-/]|\/calendar\/ical\/|\.ics(?:$|[?#]))/i.test(raw)) {
      return `${diagnosticAddress(raw)}/[redacted]`;
    }
  } catch { /* a non-URL is handled by the other redactors */ }
  return raw;
}

/** Untrusted diagnostic prose may echo an arbitrary secret subscription path. */
export function diagnosticText(value) {
  return redact(String(value ?? '')).replace(URL_TEXT, raw => withUrlPunctuation(raw, diagnosticAddress));
}

export function redact(input, seen = new WeakSet()) {
  if (typeof input === 'string') {
    let out = input;
    out = out.replace(URL_TEXT, raw => withUrlPunctuation(raw, redactUrl));
    out = out.replace(SECRET_ASSIGNMENT, (_match, prefix) => `${prefix}[redacted]`);
    for (const re of SECRET_SHAPES) out = out.replace(re, (m) => mask(m));
    return out;
  }
  if (!input || typeof input !== 'object') return input;
  if (seen.has(input)) return '[circular]';
  seen.add(input);
  if (Array.isArray(input)) return input.map((v) => redact(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEYS.has(normalizedKey(k))) out[k] = typeof v === 'string' && v ? mask(v) : v ? '[redacted]' : v;
    else out[k] = redact(v, seen);
  }
  return out;
}

function mask(s) {
  if (typeof s !== 'string' || s.length <= 8) return '[redacted]';
  return `${s.slice(0, 4)}…[redacted ${s.length}ch]`;
}

export function createLogger({ dir = null, level = 'info', stream = process.stderr, name = 'zelos' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let file = null;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      file = fs.createWriteStream(path.join(dir, `${name}.log`), { flags: 'a', mode: 0o600 });
      // Opening and writing a stream can fail after createWriteStream returns.
      // A missing log destination must not become an unhandled error that
      // brings down the board. Keep the terminal sink available for diagnosis.
      file.on('error', (err) => {
        file = null;
        emit('warn', 'File logging is unavailable; continuing with terminal diagnostics', { error: err.message });
      });
    } catch {
      file = null; // logging must never be the reason the app fails to start
    }
  }

  function emit(lvl, msg, meta) {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const safeMsg = redact(String(msg));
    const safeMeta = meta === undefined ? undefined : redact(meta);
    const line = { t: new Date().toISOString(), lvl, msg: safeMsg, ...(safeMeta ? { meta: safeMeta } : {}) };
    if (file) file.write(`${JSON.stringify(line)}\n`);
    if (stream && lvl !== 'debug') {
      const tag = { info: '·', warn: '!', error: '✕' }[lvl] || '·';
      stream.write(`${tag} ${safeMsg}${safeMeta ? ` ${JSON.stringify(safeMeta)}` : ''}\n`);
    }
  }

  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child(prefix) {
      return {
        debug: (m, x) => emit('debug', `${prefix} ${m}`, x),
        info: (m, x) => emit('info', `${prefix} ${m}`, x),
        warn: (m, x) => emit('warn', `${prefix} ${m}`, x),
        error: (m, x) => emit('error', `${prefix} ${m}`, x),
        child(p2) { return this; },
      };
    },
    close() {
      const closing = file;
      file = null;
      try { closing?.end(); } catch { /* ignore */ }
    },
  };
}

/** Default logger — quiet, no file, safe to import anywhere. */
export const log = createLogger({ level: process.env.ZELOS_LOG_LEVEL || 'info' });
