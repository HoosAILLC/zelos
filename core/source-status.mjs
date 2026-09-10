/** Durable fetch health, separate from connector cursors and pacing state. */
import { getKV, setKV } from './db.mjs';
import { get as connectorFor, sourceStateKey } from './connectors/index.mjs';
import { instant } from './time.mjs';
import { log, redact } from './log.mjs';

const PREFIX = 'source.health.';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 500) => typeof value === 'string' ? redact(value).slice(0, limit) : '';
const iso = (value) => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? instant(value) : null;
  return ms !== null && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};
const latest = (values) => values.filter(Boolean).reduce((last, value) =>
  !last || Date.parse(value) > Date.parse(last) ? value : last, null);

function readJSON(db, key) {
  try {
    const value = JSON.parse(getKV(db, key));
    return object(value) ? value : {};
  } catch { return {}; }
}

function health(db, id) {
  const saved = readJSON(db, PREFIX + id);
  return {
    id,
    kind: text(saved.kind, 64),
    ok: typeof saved.ok === 'boolean' ? saved.ok : null,
    lastAttemptAt: iso(saved.lastAttemptAt),
    lastSuccessAt: iso(saved.lastSuccessAt),
    error: text(saved.error) || null,
    retryAt: iso(saved.retryAt),
  };
}

/**
 * Record real source checks, aggregated across folders/parts. One partial or
 * failed part means the source did not fully succeed. Omitted sources and
 * attempted:false pauses never advance either fetch timestamp. `now` is the
 * fetch/run start time, not the time a potentially slow model finished.
 */
export function recordSourceResults(db, results, now) {
  const at = iso(now);
  if (!at || !Array.isArray(results)) return 0;
  const groups = new Map();
  for (const result of results) {
    if (!object(result) || typeof result.id !== 'string' || !result.id || result.id.length > 200) continue;
    const group = groups.get(result.id) || [];
    group.push(result);
    groups.set(result.id, group);
  }
  let written = 0;
  for (const [id, parts] of groups) {
    const saved = health(db, id);
    const attempted = parts.filter((part) => part.attempted !== false);
    const complete = attempted.length > 0 && attempted.length === parts.length
      && attempted.every((part) => part.ok === true && !part.error && !part.note);
    const errors = [...new Set(parts.map((part) => text(part.error) || text(part.note)).filter(Boolean))];
    const retryAt = latest(parts.map((part) => iso(part.retryAt)));
    const next = { ...saved, kind: text(parts[0].kind, 64) || saved.kind };

    // A slow earlier run must not replace the outcome of a later attempt.
    if (attempted.length && (!saved.lastAttemptAt || Date.parse(at) >= Date.parse(saved.lastAttemptAt))) {
      next.ok = complete;
      next.lastAttemptAt = at;
      next.error = complete ? null : errors.join('; ').slice(0, 500) || 'The source did not finish reading.';
      next.retryAt = complete ? null : retryAt;
    } else if (!attempted.length) {
      // A known pause can supply retry information, but cannot claim a read.
      next.retryAt = retryAt || saved.retryAt;
      if (parts.some((part) => part.ok === false || part.error || part.note)) {
        next.ok = false;
        next.error = errors.join('; ').slice(0, 500) || saved.error;
      }
    }
    if (complete) next.lastSuccessAt = latest([saved.lastSuccessAt, at]);

    try {
      setKV(db, PREFIX + id, JSON.stringify(next));
      written++;
    } catch (err) {
      // Health is display metadata. Losing a status must not fail a sweep.
      log.warn('Could not record source reading status', { id, error: err.message });
    }
  }
  return written;
}

/** Read-only API rows for configured sources, including paused/unknown ones. */
export function readSourceStatus(db, config = {}, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : instant(now) ?? Date.now();
  const rows = [];
  for (const configKey of ['mail', 'calendars', 'sources']) {
    for (const source of Array.isArray(config?.[configKey]) ? config[configKey] : []) {
      if (!object(source) || typeof source.id !== 'string' || !source.id) continue;
      const type = configKey === 'mail' ? 'imap' : configKey === 'sources' ? source.type : source.kind;
      const connector = connectorFor(type) || (configKey === 'calendars' ? connectorFor('ics') : null);
      const kind = configKey === 'mail' ? 'mail' : configKey === 'calendars' ? 'calendar' : connector?.family || text(type, 64) || 'source';
      const enabled = source.enabled !== false;
      const stored = health(db, source.id);
      // Connector pacing is useful; its old lastOkAt is not evidence of a
      // complete fetch and must never be promoted to a success timestamp.
      const state = readJSON(db, sourceStateKey(source.id));
      const retryAt = latest([
        stored.retryAt,
        iso(state.notBefore),
        iso(state.authBlockedUntil),
        state.lastAt && connector?.limits?.minIntervalMs
          ? iso(Number(state.lastAt) + connector.limits.minIntervalMs) : null,
      ]);
      rows.push({
        ...stored,
        kind,
        configKey,
        label: text(source.label || source.host || connector?.label || source.id, 200),
        enabled,
        retryAt: enabled && retryAt && Date.parse(retryAt) > nowMs ? retryAt : null,
      });
    }
  }
  return rows;
}
