import { el, button, replace } from './dom.js';
import { request } from './api.js';
import { timezone } from './store.js';
import { BUCKET_LABEL, SEVERITY_LABEL } from './format.js';
import { formatTime } from './time.js';

const FIELDS = {
  headline: 'Headline', why: 'Reason', due_at: 'Deadline', bucket: 'Section',
  severity: 'Priority', state: 'Status', snoozed_until: 'Snoozed until', sourceInactive: 'Task selection',
};
const ORIGINS = {
  model: 'Model review', source: 'Source refresh', user: 'You',
  automatic: 'Automatic', sample: 'Sample data', unknown: 'Origin not recorded',
};
const VALUES = {
  bucket: BUCKET_LABEL,
  state: { open: 'Open', done: 'Done', dismissed: 'Dismissed', snoozed: 'Snoozed' },
  severity: SEVERITY_LABEL,
};

function timestamp(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Time not recorded';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: timezone(),
  }).format(new Date(value));
}

function valueLabel(field, value) {
  if (value === null || value === undefined || value === '') return 'None';
  if (field === 'sourceInactive') return value ? 'No longer in task selection' : 'In task selection';
  if (field === 'snoozed_until') return timestamp(value);
  if (field === 'due_at') {
    // A day-only deadline is a calendar date, never a UTC midnight to shift.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    // Match the card: retain the deadline's printed wall clock, even when the
    // configured zone differs. Recorded-at and snooze times use the user's zone.
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && formatTime(value)
      ? `${value.slice(0, 10)} · ${formatTime(value)}` : String(value);
  }
  return VALUES[field]?.[value] ?? String(value);
}

export function historyChangeText(change, { created = false } = {}) {
  const field = FIELDS[change.field];
  if (!field) return null;
  const after = valueLabel(change.field, change.after);
  const text = created ? `${field}: ${after}` : `${field}: ${valueLabel(change.field, change.before)} → ${after}`;
  const notes = [change.truncated ? 'long text shortened' : '', change.redacted ? 'credentials hidden' : ''].filter(Boolean);
  return `${text}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

function historyEntry(entry) {
  return el('li', { class: 'item-history-entry' }, [
    el('p', { class: 'item-history-meta meta mono' }, [
      el('time', { datetime: entry.recorded_at, text: timestamp(entry.recorded_at) }),
      el('span', { text: ` · ${ORIGINS[entry.origin] ?? ORIGINS.unknown} · ${entry.kind === 'created' ? 'Added' : 'Changed'}` }),
    ]),
    el('ul', { class: 'item-history-changes' }, (entry.changes ?? []).map((change) => {
      const text = historyChangeText(change, { created: entry.kind === 'created' });
      return text ? el('li', { text }) : null;
    })),
  ]);
}

/** Loaded only when asked; source text always reaches textContent, never HTML. */
export function itemHistory(item, { fetchHistory = request } = {}) {
  let loaded = false;
  let busy = false;
  let nextBefore = null;
  const list = el('ol', { class: 'item-history-list' });
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite' });
  const foot = el('div');
  const panel = el('section', {
    class: 'item-history', hidden: true, 'aria-label': `What changed: ${item.headline || 'this item'}`,
  }, [list, status, foot]);

  async function load() {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading changes…';
    replace(foot, null);
    try {
      const cursor = nextBefore === null ? '' : `&before=${encodeURIComponent(nextBefore)}`;
      const result = await fetchHistory(`/api/items/${encodeURIComponent(item.id)}/history?limit=20${cursor}`);
      for (const entry of result.entries) list.appendChild(historyEntry(entry));
      loaded = true;
      nextBefore = result.nextBefore;
      status.textContent = list.children.length
        ? 'Earlier changes made before history was introduced are not available.'
        : 'No changes recorded yet. Earlier changes made before history was introduced are not available.';
      if (nextBefore !== null) replace(foot, button('Older changes', { class: 'btn quiet', onClick: load }));
    } catch {
      status.textContent = 'History could not be loaded.';
      replace(foot, button('Try again', { class: 'btn quiet', onClick: load }));
    } finally {
      busy = false;
      panel.setAttribute('aria-busy', 'false');
    }
  }

  const toggle = button('What changed?', {
    class: 'btn quiet', 'aria-expanded': 'false',
    onClick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      if (!open && !loaded) return load();
    },
  });
  return { toggle, panel };
}
