/** Stored reading results, shared by the board and connection settings. */
import { el, button, meander } from './dom.js';
import { state, timezone } from './store.js';
import { formatDay, formatTime, toZonedISO } from './time.js';

export function sourceStatuses() {
  const reports = Array.isArray(state.board.sourceStatus) ? state.board.sourceStatus : null;
  const last = state.board.runs?.last;
  return ['mail', 'calendars', 'sources'].flatMap(configKey => (state.config?.[configKey] || []).map(source => {
    const kind = configKey === 'mail' ? 'mail' : configKey === 'calendars' ? 'calendar' : source.type;
    const current = reports?.find(row => row.id === source.id && row.configKey === configKey);
    // Older servers expose only the latest check. A missing result is unknown,
    // never evidence that the source was read or that it has never been read.
    const entries = (last?.stats?.sources || []).filter(row => row.id === source.id && row.kind === kind);
    const ok = entries.length ? entries.every(row => row.ok === true) : null;
    const attempted = entries.length ? last.ended_at || last.started_at || null : null;
    return {
      id: source.id, kind, configKey, ok,
      lastAttemptAt: attempted,
      lastSuccessAt: ok === true ? attempted : null,
      error: entries.filter(row => row.ok === false).map(row => row.error).filter(Boolean).join(' · ') || null,
      ...(current || {}),
      enabled: source.enabled !== false,
      label: source.label || current?.label || source.user || kind || 'Connection',
      unknown: !reports && !entries.length,
    };
  }));
}

function when(iso) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return null;
  const zoned = toZonedISO(new Date(stamp), timezone());
  return `${formatDay(zoned)}, ${zoned.slice(0, 4)} · ${formatTime(zoned)}`;
}

function reportNode(report) {
  const paused = !report.enabled;
  const title = paused ? 'Paused'
    : report.ok === false ? 'Needs attention'
      : report.ok === true ? 'Read successfully'
        : report.unknown ? 'No reading result available' : 'Not checked yet';
  const success = when(report.lastSuccessAt);
  const attempted = when(report.lastAttemptAt);
  const retry = when(report.retryAt);
  return el('div', { class: 'source-status' }, [
    el('p', { class: `quiet-note${!paused && report.ok === false ? ' is-bad' : ''}`, text: title }),
    success ? el('p', { class: 'quiet-note', text: `Last successful read: ${success}` })
      : !paused && report.ok === false ? el('p', { class: 'quiet-note', text: 'No successful read time recorded.' }) : null,
    !paused && report.ok === false && attempted ? el('p', { class: 'quiet-note', text: `Last tried: ${attempted}` }) : null,
    !paused && report.ok === false && report.error ? el('p', { class: 'quiet-note', text: report.error }) : null,
    !paused && retry ? el('p', { class: 'quiet-note', text: `Can retry after: ${retry}` }) : null,
  ]);
}

export function sourceStatusLine(id, configKey) {
  const report = sourceStatuses().find(row => row.id === id && row.configKey === configKey);
  return report ? reportNode(report) : null;
}

export function readingStatus(navigate) {
  const reports = sourceStatuses();
  if (!reports.length) return null;
  const failed = reports.filter(row => row.enabled && row.ok === false).length;
  const panel = el('div', { class: 'worth-body', hidden: !failed }, el('div', { class: 'stack' }, reports.map(report =>
    el('article', { class: 'account' }, [
      el('h3', { class: 'account-label', text: report.label }),
      reportNode(report),
      button(report.enabled && report.ok === false ? 'Review connection' : 'Connection settings', {
        class: 'btn quiet',
        'aria-label': `${report.enabled && report.ok === false ? 'Review connection' : 'Connection settings'}: ${report.label}`,
        onClick: () => navigate(`#/settings/${report.configKey}`),
      }),
    ]))));
  const toggle = el('button', {
    type: 'button', class: 'worth-toggle', 'aria-expanded': failed ? 'true' : 'false',
    onclick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    },
  }, [
    el('span', { text: 'Reading status' }),
    el('span', { class: 'mono worth-count', text: failed ? `${failed} need attention` : String(reports.length) }),
  ]);
  return el('section', { class: 'section worth' }, [toggle, meander(), panel]);
}
