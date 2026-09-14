/** Recorded completions and local weekly PDF reports. No AI or external I/O. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { addDaysToKey, startOfWeekKey, toZonedISO } from './time.mjs';
import { cap } from './safety.mjs';

const FONTS = fileURLToPath(new URL('../assets/report-fonts/', import.meta.url));
const BUCKET_NAMES = { now: 'Now', today: 'Today', soon: 'Soon', waiting: 'Waiting', promised: 'Promised', money: 'Money', note: 'Notes' };
const COVERAGE = 'Only recorded changes to Done count. Reopened work is shown separately, and each task counts once per week. Older imported completions and deleted records cannot be reconstructed.';
export class ProgressError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ProgressError'; this.status = status; }
}
function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function changes(value) { const parsed = json(value, []); return Array.isArray(parsed) ? parsed : []; }
function clean(value, max = 500) { return cap(typeof value === 'string' ? value : '', max).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ''); }
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
function optionsOf({ week, tz = 'UTC', now = new Date() } = {}) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(); } catch { throw new ProgressError('Choose a valid time zone.'); }
  const asOf = new Date(now);
  if (!Number.isFinite(asOf.getTime())) throw new ProgressError('The report date is invalid.');
  const day = week || toZonedISO(asOf, tz).slice(0, 10);
  if (!validDay(day)) throw new ProgressError('Choose a week using a date such as 2026-09-07.');
  const start = startOfWeekKey(day, 1), next = addDaysToKey(start, 7), end = addDaysToKey(start, 6);
  return { week: start, start, end, next, tz, asOf: asOf.toISOString() };
}
function companyOf(payload) {
  return clean(payload?.companyName || (typeof payload?.company === 'string' ? payload.company : payload?.company?.name), 100) || 'Unassigned';
}
function groups(entries, field, names = {}) {
  const counts = new Map();
  for (const entry of entries) { const key = entry[field] || 'Unassigned'; counts.set(key, (counts.get(key) || 0) + 1); }
  return [...counts].map(([key, count]) => ({ key, label: names[key] || key, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
function aggregate(entries, range) {
  const daily = Array.from({ length: 7 }, (_, index) => ({ date: addDaysToKey(range.start, index), label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index], count: 0 }));
  for (const entry of entries) { const day = daily.find(row => row.date === entry.day); if (day) day.count++; }
  return { completed: entries.length, activeDays: daily.filter(day => day.count).length,
    completionEvents: entries.reduce((sum, entry) => sum + entry.completionEvents, 0), daily,
    buckets: groups(entries, 'bucket', BUCKET_NAMES), companies: groups(entries, 'company') };
}
function automatedJobs(db, range) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_jobs'").get()) return { count: 0, entries: [] };
  const rows = db.prepare("SELECT id,prompt,finished_at FROM assistant_jobs WHERE status='completed' AND finished_at IS NOT NULL AND julianday(finished_at) <= julianday(?) ORDER BY julianday(finished_at) DESC").all(range.asOf);
  const entries = rows.flatMap(row => {
    const finishedAt = toZonedISO(row.finished_at, range.tz), day = finishedAt?.slice(0, 10);
    return day && day >= range.start && day < range.next ? [{ id: row.id, title: clean(row.prompt, 300), finishedAt }] : [];
  });
  return { count: entries.length, entries: entries.slice(0, 100), more: entries.length > 100 };
}

/** Monday-based week, evaluated as of that week's end (or now for the current week). */
export function getProgress(db, options = {}) {
  const range = optionsOf(options);
  const low = new Date(Date.parse(`${range.start}T00:00:00Z`) - 86_400_000).toISOString();
  const high = new Date(Date.parse(`${range.next}T00:00:00Z`) + 86_400_000).toISOString();
  const rows = db.prepare(`SELECT h.*, i.headline, i.why, i.bucket, i.payload_json
    FROM item_history h JOIN items i ON i.id = h.item_id
    WHERE julianday(h.recorded_at) >= julianday(?) AND julianday(h.recorded_at) < julianday(?)
      AND julianday(h.recorded_at) <= julianday(?)
    ORDER BY julianday(h.recorded_at), h.id LIMIT 10001`).all(low, high, range.asOf);
  if (rows.length > 10000) throw new ProgressError('This week has too many revisions to report safely. Choose a quieter week or reduce the retained history.', 413);
  const tracked = new Map();
  for (const row of rows) {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.recorded_at)) continue;
    const zoned = toZonedISO(row.recorded_at, range.tz), day = zoned?.slice(0, 10);
    if (!day || day < range.start || day >= range.next || row.kind !== 'changed') continue;
    const change = changes(row.changes_json).find(change => change?.field === 'state' && change.before !== change.after);
    if (!change) continue;
    if (change.after === 'done' && change.before !== 'done') {
      const previous = tracked.get(row.item_id);
      tracked.set(row.item_id, { ...row, day, completedAt: zoned, finalState: 'done', completionEvents: (previous?.completionEvents || 0) + 1 });
    } else if (tracked.has(row.item_id)) {
      Object.assign(tracked.get(row.item_id), { finalState: change.after, reopenedAt: zoned });
    }
  }
  const entries = [...tracked.values()].map(row => {
    // The row may have been renamed after completion. Undo every later
    // recorded revision to report the title and description at completion.
    const snapshot = { headline: row.headline, why: row.why, bucket: row.bucket };
    const later = db.prepare(`SELECT changes_json FROM item_history WHERE item_id = ?
      AND (julianday(recorded_at) > julianday(?) OR (julianday(recorded_at) = julianday(?) AND id > ?))
      ORDER BY julianday(recorded_at) DESC, id DESC`).all(row.item_id, row.recorded_at, row.recorded_at, row.id);
    for (const revision of later) for (const change of changes(revision.changes_json)) {
      if (change && Object.hasOwn(snapshot, change.field)) snapshot[change.field] = change.before;
    }
    return { id: row.item_id, eventId: row.id, title: clean(snapshot.headline) || 'Untitled task', description: clean(snapshot.why, 2000),
      bucket: clean(snapshot.bucket, 40) || 'note', bucketLabel: BUCKET_NAMES[snapshot.bucket] || clean(snapshot.bucket, 40) || 'Notes',
      company: companyOf(json(row.payload_json, {})), day: row.day, completedAt: row.completedAt,
      origin: clean(row.origin, 40), completionEvents: row.completionEvents,
      status: row.finalState === 'done' ? 'completed' : 'reopened', reopenedAt: row.reopenedAt || null };
  }).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.eventId - a.eventId);
  const completed = entries.filter(entry => entry.status === 'completed');
  const totals = aggregate(completed, range);
  const recordedSince = db.prepare('SELECT v FROM kv WHERE k = ?').get('itemHistory.startedAt')?.v || null;
  return { ...range, entries, totals, reopened: entries.filter(entry => entry.status === 'reopened').length,
    completionEvents: entries.reduce((sum, entry) => sum + entry.completionEvents, 0), recordedSince, coverage: COVERAGE,
    companyNote: 'Company groups use current, explicitly assigned labels.', automatedJobs: automatedJobs(db, range) };
}

export function weeklyReportData(db, options = {}) {
  const progress = getProgress(db, options);
  const eligible = progress.entries.filter(entry => entry.status === 'completed');
  const ids = options.selectedIds === undefined ? eligible.map(entry => entry.id) : options.selectedIds;
  if (!Array.isArray(ids) || ids.length > 2000 || ids.some(id => typeof id !== 'string' || id.length > 200)) throw new ProgressError('Choose at most 2,000 completed tasks for the report.');
  const chosen = new Set(ids), allowed = new Set(eligible.map(entry => entry.id));
  if ([...chosen].some(id => !allowed.has(id))) throw new ProgressError('A selected task is no longer completed in this week. Refresh the progress page and review the selection.', 409);
  if (options.title !== undefined && (typeof options.title !== 'string' || options.title.length > 120)) throw new ProgressError('The report title must be at most 120 characters.');
  for (const field of ['includeDetails', 'includeTitles', 'includeCompanies']) if (options[field] !== undefined && typeof options[field] !== 'boolean') throw new ProgressError(`The ${field} choice must be on or off.`);
  const selected = eligible.filter(entry => chosen.has(entry.id));
  const totals = aggregate(selected, progress);
  const includeTitles = options.includeTitles !== false, includeDetails = options.includeDetails === true && includeTitles;
  const includeCompanies = options.includeCompanies === true;
  // Omitted details are removed here, before PDF creation. No excluded rows,
  // descriptions, or company names can appear in metadata or hidden content.
  return { week: progress.week, start: progress.start, end: progress.end, next: progress.next, tz: progress.tz,
    title: clean(options.title, 120) || 'Weekly progress',
    totals: { ...totals, companies: includeCompanies ? totals.companies : [] },
    entries: selected.map(entry => ({ day: entry.day, completedAt: entry.completedAt, bucketLabel: entry.bucketLabel,
      title: includeTitles ? entry.title : null, description: includeDetails ? entry.description : null,
      company: includeCompanies ? entry.company : null })), includeTitles, includeDetails, includeCompanies };
}

/** A complete PDF Buffer, with embedded local fonts and vector graphs. */
export async function buildWeeklyReport(db, options = {}) {
  const report = weeklyReportData(db, options);
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 44, right: 44, bottom: 68, left: 44 }, bufferPages: true, autoFirstPage: true,
    info: { Title: report.title, Author: 'Zelos', Subject: `Selected recorded completions for ${report.start} to ${report.end}`, Creator: 'Zelos' } });
  doc.registerFont('Report', path.join(FONTS, 'DejaVuSans.ttf'));
  doc.registerFont('ReportBold', path.join(FONTS, 'DejaVuSans-Bold.ttf'));
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const ink = '#17201E', muted = '#60706A', green = '#276F5C', pale = '#EFF5F1', line = '#DDE6E0';
  const left = 44, width = 524, bottom = 724;
  const safeText = text => clean(text, 4000).replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ');
  const text = (value, x, y, size = 10, color = ink, opts = {}) => doc.font(opts.bold ? 'ReportBold' : 'Report').fontSize(size).fillColor(color).text(safeText(value), x, y, { width: opts.width ?? width, lineGap: 3, ...opts });
  const rule = y => doc.moveTo(left, y).lineTo(left + width, y).lineWidth(.6).strokeColor(line).stroke();
  const dateLabel = key => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
  text('ZELOS / WEEKLY REVIEW', left, 36, 9, green, { bold: true, characterSpacing: 1.2 });
  text(report.title, left, 63, 24, ink, { bold: true, width });
  let y = doc.y + 11;
  text(`${dateLabel(report.start)} - ${dateLabel(report.end)}`, left, y, 11, muted);
  text(report.tz, left, y + 20, 8, muted);
  y += 52;
  const metrics = [['COMPLETED', report.totals.completed], ['ACTIVE DAYS', report.totals.activeDays], ['DONE ACTIONS', report.totals.completionEvents]];
  metrics.forEach(([label, value], index) => {
    const x = left + index * 179;
    doc.roundedRect(x, y, 166, 78, 8).fill(pale);
    text(label, x + 14, y + 12, 8, muted, { bold: true, width: 140 });
    text(String(value), x + 14, y + 29, 28, ink, { bold: true, width: 140 });
  });
  y += 103;
  text('Completions through the week', left, y, 12, ink, { bold: true });
  y += 35;
  const max = Math.max(1, ...report.totals.daily.map(day => day.count));
  const chartHeight = 94, step = width / 7;
  for (const [index, day] of report.totals.daily.entries()) {
    const x = left + index * step + 16, height = day.count / max * chartHeight;
    doc.roundedRect(x, y, 42, chartHeight, 4).fill(pale);
    if (height > 0) doc.roundedRect(x, y + chartHeight - height, 42, height, Math.min(4, height / 2)).fill(green);
    text(String(day.count), x, y - 19, 10, ink, { align: 'center', width: 42 });
    text(day.label, x - 6, y + chartHeight + 9, 9, muted, { align: 'center', width: 54 });
  }
  y += chartHeight + 49;
  const groupRows = Math.max(report.totals.buckets.length, report.includeCompanies ? report.totals.companies.length : 0);
  const groupHeight = 26 + Math.max(1, Math.min(5, groupRows)) * 34 + (groupRows > 5 ? 24 : 0);
  if (y + groupHeight > bottom) { doc.addPage(); y = 45; }
  const breakdown = (title, rows, x, blockWidth) => {
    text(title, x, y, 11, ink, { bold: true, width: blockWidth });
    let rowY = y + 26;
    const shown = rows.slice(0, 5);
    if (!shown.length) { text('No selected completions', x, rowY, 9, muted, { width: blockWidth }); return rowY + 23; }
    const top = Math.max(1, ...shown.map(row => row.count));
    for (const row of shown) {
      text(row.label, x, rowY, 9, ink, { width: blockWidth - 26, height: 16, ellipsis: true });
      text(String(row.count), x + blockWidth - 24, rowY, 9, muted, { width: 24, align: 'right' });
      doc.roundedRect(x, rowY + 18, blockWidth, 5, 2).fill(pale);
      doc.roundedRect(x, rowY + 18, Math.max(2, blockWidth * row.count / top), 5, 2).fill(green);
      rowY += 34;
    }
    if (rows.length > 5) { text(`+ ${rows.length - 5} additional groups in selected work`, x, rowY, 8, muted, { width: blockWidth }); rowY += 24; }
    return rowY;
  };
  const categoryY = breakdown('By category', report.totals.buckets, left, report.includeCompanies ? 246 : width);
  const companyY = report.includeCompanies ? breakdown('By company', report.totals.companies, left + 278, 246) : categoryY;
  y = Math.max(categoryY, companyY) + 18;
  if (y > bottom - 55) { doc.addPage(); y = 45; }
  text('Counts include only selected tasks still marked Done at the end of this week, or now if the week is ongoing. A task completed twice counts once; Done actions records both explicit changes.', left, y, 8, muted, { width });
  y = doc.y + 22;
  if (report.includeCompanies) { text('Company groups use current, explicitly assigned labels.', left, y, 8, muted); y = doc.y + 18; }
  if (report.includeTitles && report.entries.length) {
    const chronological = [...report.entries].reverse();
    const entryHeight = (entry, newDay) => doc.font('ReportBold').fontSize(10).heightOfString(safeText(entry.title), { width: width - 16, lineGap: 3 })
      + (entry.description ? doc.font('Report').fontSize(9).heightOfString(safeText(entry.description), { width: width - 16, lineGap: 3 }) : 0)
      + (newDay ? 32 : 0) + 36;
    if (y + 51 + Math.min(entryHeight(chronological[0], true), bottom - 96) > bottom) { doc.addPage(); y = 45; }
    rule(y); y += 17;
    text('Selected completed work', left, y, 14, ink, { bold: true }); y += 34;
    let previousDay = null;
    for (const [index, entry] of chronological.entries()) {
      const need = entryHeight(entry, entry.day !== previousDay);
      if (index > 0 && y + need > bottom) { doc.addPage(); y = 45; previousDay = null; }
      if (entry.day !== previousDay) { text(dateLabel(entry.day), left, y, 9, green, { bold: true }); y += 23; previousDay = entry.day; }
      doc.circle(left + 3, y + 6, 2.4).fill(green);
      text(entry.title, left + 16, y, 10, ink, { bold: true, width: width - 16 }); y = doc.y + 6;
      text([entry.bucketLabel, entry.company].filter(Boolean).join(' / '), left + 16, y, 8, muted, { width: width - 16 }); y = doc.y + 7;
      if (entry.description) { text(entry.description, left + 16, y, 9, muted, { width: width - 16 }); y = doc.y + 11; }
      y += 10;
    }
  } else if (!report.entries.length) {
    text('No completed tasks were selected for this report.', left, y, 11, muted);
  }
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    // Footer text lives below the content margin. Let it stay on the existing
    // page instead of triggering PDFKit's automatic text pagination.
    const contentMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    rule(744);
    text('Prepared locally in Zelos. Review before sharing.', left, 754, 7, muted, { width: 410, lineBreak: false });
    text(`${index + 1} / ${pages.count}`, 514, 754, 7, muted, { width: 54, align: 'right', lineBreak: false });
    doc.page.margins.bottom = contentMargin;
  }
  doc.end();
  return done;
}
