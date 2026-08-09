/**
 * ui/lib/api.js — the only place the page talks to the server.
 *
 * Two things here are load-bearing:
 *
 *  1. The session token. core/server.mjs mints it per launch and puts it in the
 *     launch URL as `?t=…`; every /api/* request must carry it in
 *     `X-Zelos-Token` or it is a 401. It is lifted out of the URL once and
 *     stripped from the address bar (history.replaceState) so it does not sit in
 *     a screenshot, a bookmark or a Referer — then kept in sessionStorage, which
 *     dies with the tab, rather than localStorage, which does not.
 *
 *  2. SSE over fetch. `EventSource` cannot set a header, so it cannot send the
 *     token — both streams (`/api/sweep/stream`, `POST /api/ask`) are read off a
 *     fetch body reader with a hand-written SSE parser instead.
 */

const TOKEN_KEY = 'zelos.token';

function readToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode: the in-memory copy below still works for this page load */
    }
    url.searchParams.delete('t');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

let token = readToken();

export function hasToken() {
  return Boolean(token);
}

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

function headers(extra = {}) {
  return { 'X-Zelos-Token': token, ...extra };
}

/**
 * A JSON request. Errors arrive as `{error, detail}` from the server; anything
 * else (a proxy, a dead socket) becomes an ApiError that still names the path,
 * so "the server is gone" never renders as "undefined".
 */
export async function request(path, { method = 'GET', body = undefined, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? headers() : headers({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(`Zelos is not answering on ${window.location.host}. Is it still running?`, { path });
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const message = parsed && typeof parsed.error === 'string'
      ? parsed.error
      : `${method} ${path} failed (${res.status})`;
    throw new ApiError(message, { status: res.status, detail: parsed?.detail ?? null, path });
  }
  return parsed;
}

/**
 * True when a build simply does not have this route: 404 from the router, or
 * 501 from a route that exists and says it is unimplemented. Callers render an
 * honest "not in this build" state rather than an error — see
 * ui/views/ai-access.js, whose whole panel is optional in exactly that way.
 */
export function isMissingRoute(err) {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

/* --------------------------------------------------------------- endpoints */

export const api = {
  health: () => request('/api/health'),
  state: () => request('/api/state'),
  config: () => request('/api/config'),
  saveConfig: (patch) => request('/api/config', { method: 'PUT', body: patch }),
  sweep: (mode = 'auto') => request('/api/sweep', { method: 'POST', body: { mode } }),
  setItemState: (id, state) =>
    request(`/api/items/${encodeURIComponent(id)}/state`, { method: 'POST', body: { state } }),
  capture: (text) => request('/api/capture', { method: 'POST', body: { text } }),
  setSecret: (ref, value) => request('/api/secrets', { method: 'POST', body: { ref, value } }),
  deleteSecret: (ref) => request(`/api/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  testModel: (spec) => request('/api/model/test', { method: 'POST', body: spec }),
  listModels: ({ protocol, baseUrl, keyRef }) => {
    const q = new URLSearchParams();
    if (protocol) q.set('protocol', protocol);
    if (baseUrl) q.set('baseUrl', baseUrl);
    if (keyRef) q.set('keyRef', keyRef);
    return request(`/api/model/list?${q.toString()}`);
  },
  presets: () => request('/api/model/presets'),
  probeLocal: () => request('/api/local/probe'),
  testMail: (account) => request('/api/mail/test', { method: 'POST', body: account }),
  testCalendar: (calendar) => request('/api/calendar/test', { method: 'POST', body: calendar }),
  updateDraft: (id, patch) =>
    request(`/api/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  search: (q) => request(`/api/search?q=${encodeURIComponent(q)}`),

  /* AI access (SPEC-v2 §1). All four answer with the same whole-state payload —
     switch, scopes, effective scopes, tokens, access log and client hints — so
     the panel applies a change by keeping the response rather than by guessing
     what the server did with it. A minted token's `value` appears in the mint
     response and nowhere else, ever. */
  ai: () => request('/api/ai'),
  saveAi: (patch) => request('/api/ai', { method: 'PUT', body: patch }),
  mintAiToken: (label) => request('/api/ai/tokens', { method: 'POST', body: { label } }),
  revokeAiToken: (id) => request(`/api/ai/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/* --------------------------------------------------------------------- SSE */

/**
 * Parse an SSE byte stream into `{event, data}`. Frames are separated by a
 * blank line; `data:` lines within one frame join with `\n`; a line starting
 * `:` is a comment (the server's heartbeat) and is dropped.
 */
function makeSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let split;
    // \r\n\r\n is legal too; normalise before splitting on the blank line.
    buffer = buffer.replace(/\r\n/g, '\n');
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') name = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length && name === 'message') continue;
      let payload = null;
      const joined = data.join('\n');
      if (joined) {
        try {
          payload = JSON.parse(joined);
        } catch {
          payload = joined;
        }
      }
      onEvent(name, payload);
    }
  };
}

/**
 * Open an SSE stream and pump it into `onEvent` until it ends or `signal`
 * aborts. Resolves when the stream closes; rejects only on a transport failure,
 * so callers can distinguish "the server hung up" from "the answer finished".
 */
export async function openStream(path, { method = 'GET', body = undefined, signal, onEvent }) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? headers({ Accept: 'text/event-stream' })
      : headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    throw new ApiError(parsed?.error || `stream ${path} failed (${res.status})`, {
      status: res.status,
      path,
    });
  }
  if (!res.body) throw new ApiError(`stream ${path} returned no body`, { path });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const feed = makeSseParser(onEvent);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
