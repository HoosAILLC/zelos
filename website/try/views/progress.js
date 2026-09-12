/** A record of finished work, with a deliberately reviewed PDF export. */
import { el, button } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { disclosure, reveal } from '../lib/workspace.js';

const cached = { root: null, week: '', tz: 'UTC', data: null, selected: new Set(), title: 'Weekly progress',
  includeTitles: true, includeDetails: false, includeCompanies: false, loading: false, exporting: false, request: 0, error: '', notice: '' };
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dateLabel = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
function field(label, node) { return el('label', { class: 'progress-field' }, [el('span', { text: label }), node]); }
function selectedEntries() { return (cached.data?.entries || []).filter(entry => entry.status === 'completed' && cached.selected.has(entry.id)); }
function note(text, extra = {}) { return el('p', { class: 'progress-note', text, ...extra }); }

async function load(week = cached.week) {
  const revision = ++cached.request;
  cached.loading = true; cached.error = ''; paint();
  try {
    const data = await api.progress({ week: week || undefined });
    if (revision !== cached.request) return;
    const changedWeek = data.week !== cached.data?.week;
    cached.data = data; cached.week = data.week;
    const eligible = data.entries.filter(entry => entry.status === 'completed').map(entry => entry.id);
    cached.selected = new Set(changedWeek ? eligible : eligible.filter(id => cached.selected.has(id)));
  } catch (error) { if (revision === cached.request) cached.error = error.message; }
  finally { if (revision === cached.request) { cached.loading = false; paint(); } }
}
function updateSelection() {
  const entries = selectedEntries();
  const summary = cached.root?.querySelector('.progress-export-selection');
  if (summary) summary.textContent = `${entries.length} completed ${entries.length === 1 ? 'task' : 'tasks'} selected. Graphs and totals in the PDF include this selection only.`;
}
async function downloadReport() {
  if (cached.exporting || cached.loading || !cached.data) return;
  cached.exporting = true; cached.error = ''; cached.notice = '';  paint();
  try {
    const response = await api.progressPdf({ week: cached.week, selectedIds: [...cached.selected], title: cached.title,
      includeTitles: cached.includeTitles, includeDetails: cached.includeDetails, includeCompanies: cached.includeCompanies });
    const blob = response?.blob || response;
    if (!(blob instanceof Blob) || blob.type && !blob.type.includes('pdf')) throw new Error('Zelos did not return a PDF. Try again.');
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: response?.filename || `zelos-week-${cached.week}.pdf` });
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    cached.notice = 'Your PDF download has started.';
  } catch (error) { cached.error = error.message; }
  finally { cached.exporting = false; paint(); }
}
function toggle(label, key, disabled = false) {
  const input = el('input', { type: 'checkbox', 'aria-label': label, disabled });
  input.checked = cached[key];
  input.addEventListener('change', () => { cached[key] = input.checked; if (key === 'includeTitles') paint(); });
  return el('label', { class: 'progress-toggle' }, [input, el('span', { text: label })]);
}
function dailyChart(daily) {
  const maximum = Math.max(1, ...daily.map(day => day.count));
  return el('div', { class: 'progress-chart', role: 'img', 'aria-label': daily.map(day => `${day.label}: ${day.count} completed`).join(', ') },
    daily.map(day => el('div', { class: 'progress-chart-column' }, [
      el('span', { class: 'progress-chart-value', text: day.count }),
      el('div', { class: 'progress-chart-track', 'aria-hidden': 'true' }, [el('div', { class: 'progress-chart-bar', style: { '--bar-height': `${day.count / maximum * 100}%` } })]),
      el('span', { class: 'progress-chart-label', text: day.label }),
    ])));
}
function grouping(title, values) {
  const max = Math.max(1, ...values.map(value => value.count));
  return el('section', { class: 'progress-group' }, [el('h3', { text: title }),
    ...(values.length ? values.map(value => el('div', { class: 'progress-group-row' }, [
      el('div', {}, [el('span', { text: value.label }), el('strong', { text: value.count })]),
      el('div', { class: 'progress-group-track', 'aria-hidden': 'true' }, [el('span', { style: { width: `${value.count / max * 100}%` } })]),
    ])) : [note('No completions recorded for this week.')]),
  ]);
}
function completionRow(entry) {
  const eligible = entry.status === 'completed';
  const check = el('input', { type: 'checkbox', 'aria-label': `Include ${entry.title} in the report`, disabled: !eligible });
  check.checked = eligible && cached.selected.has(entry.id);
  check.addEventListener('change', () => { if (check.checked) cached.selected.add(entry.id); else cached.selected.delete(entry.id); updateSelection(); });
  const when = new Intl.DateTimeFormat('en-US', { timeZone: cached.data.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(entry.completedAt));
  return el('article', { class: `progress-item ${eligible ? '' : 'is-reopened'}` }, [
    el('label', { class: 'progress-item-choice' }, [check, el('span', { class: 'sr-only', text: `Include ${entry.title}` })]),
    el('div', { class: 'progress-item-main' }, [
      el('div', { class: 'progress-item-heading' }, [el('h3', { text: entry.title }), el('span', { class: `progress-status ${eligible ? '' : 'is-reopened'}`, text: eligible ? 'Completed' : 'Reopened' })]),
      note([when, entry.bucketLabel, entry.company !== 'Unassigned' ? entry.company : '', entry.completionEvents > 1 ? `${entry.completionEvents} Done actions; counted once` : ''].filter(Boolean).join(' · ')),
      !eligible ? note('This task was reopened before the report cutoff. It is kept in history and excluded from completion totals.') : null,
      entry.description ? el('details', { class: 'progress-item-details' }, [el('summary', { text: 'Show context' }), note(entry.description)]) : null,
    ]),
  ]);
}
function paint() {
  const root = cached.root;
  if (!root) return;
  const data = cached.data;
  const date = el('input', { class: 'input', type: 'date', 'aria-label': 'Choose a week', value: cached.week, disabled: cached.loading });
  date.addEventListener('change', () => { if (date.value) load(date.value); });
  const heading = el('header', { class: 'progress-heading' }, [
    el('div', {}, [el('h1', { text: 'Progress' }), note('Completed work and weekly reports.')]),
    el('div', { class: 'workspace-actions' }, [button(cached.loading ? 'Refreshing…' : 'Refresh', { class: 'btn quiet', disabled: cached.loading, onClick: () => load() }), button('Create report', { class: 'btn solid', disabled: !data, onClick: () => { const panel=root.querySelector('.progress-export'); if(panel){panel.open=true;reveal(panel.querySelector('.workspace-disclosure-body'));} } })]),
  ]);
  const pager = el('div', { class: 'progress-week-controls' }, [
    button('Previous week', { class: 'btn quiet', disabled: cached.loading || !cached.week, onClick: () => load(addDays(cached.week, -7)) }),
    field('Week containing', date),
    button('Next week', { class: 'btn quiet', disabled: cached.loading || !cached.week, onClick: () => load(addDays(cached.week, 7)) }),
  ]);
  const content = [heading];
  if (cached.notice) content.push(note(cached.notice, {role:'status'}));
  if (cached.error) content.push(el('div', { class: 'progress-error', role: 'alert', text: cached.error }));
  if (!data) {
    content.push(pager);
    content.push(el('div', { class: 'progress-empty', role: 'status' }, [el('h2', { text: cached.loading ? 'Loading your progress…' : 'Progress is unavailable' }), note(cached.loading ? 'Reading recorded completions on Spark.' : 'Refresh to try again.')]));
    root.replaceChildren(...content); return;
  }
  content.push(el('div',{class:'progress-toolbar'},[el('div', { class: 'progress-range' }, [el('h2', { text: `${dateLabel(data.start)} – ${dateLabel(data.end)}` }), note(data.tz)]),pager]));
  content.push(el('div', { class: 'progress-metrics' }, [
    ['Completed', data.totals.completed, 'Finished this week'],
    ['Active days', data.totals.activeDays, 'Days you made progress'],
    ['Reopened', data.reopened, 'Back in progress'],
  ].map(([label, value, description]) => el('section', { class: 'progress-metric' }, [el('h3', { text: label }), el('strong', { text: value }), note(description)]))));
  content.push(el('div', { class: 'progress-insights' }, [el('section', { class: 'progress-panel' }, [el('h2', { text: 'Daily activity' }), dailyChart(data.totals.daily)]), el('div', { class: 'progress-groups' }, [grouping('By category', data.totals.buckets), grouping('By company', data.totals.companies)])]));
  const title = el('input', { class: 'input', type: 'text', maxLength: 120, value: cached.title, 'aria-label': 'Report title' });
  title.addEventListener('input', () => { cached.title = title.value; });
  content.push(disclosure('progress-report', 'Weekly report', [
    el('div', { class: 'progress-export-heading' }, [el('div', {}, [el('h2', { text: 'Your weekly report' }), note('Choose what to include, then download your PDF.')]),
      button(cached.exporting ? 'Creating PDF…' : 'Download weekly PDF', { class: 'btn solid', disabled: cached.exporting || cached.loading, onClick: downloadReport })]),
    field('Report title', title),
    el('div', { class: 'progress-export-options' }, [toggle('Include task titles', 'includeTitles'), toggle('Include descriptions', 'includeDetails', !cached.includeTitles), toggle('Include company names', 'includeCompanies')]),
    note('', { class: 'progress-note progress-export-selection', role: 'status' }),
    note('Review the selected tasks below before sharing. Turn off titles for a report with counts only.'),
  ], { className:'progress-export' }));
  content.push(el('section', { class: 'progress-panel progress-history' }, [
    el('div', { class: 'progress-history-heading' }, [el('h2', { text: 'Completion history' }),
      el('div', { class: 'progress-selection-actions' }, [button('Select completed', { class: 'btn quiet', onClick: () => { cached.selected = new Set(data.entries.filter(entry => entry.status === 'completed').map(entry => entry.id)); paint(); } }),
        button('Clear selection', { class: 'btn quiet', onClick: () => { cached.selected.clear(); paint(); } })])]),
    ...(data.entries.length ? data.entries.map(completionRow) : [el('div', { class: 'progress-empty' }, [el('h3', { text: 'No recorded completions this week' }), note('Mark a task Done when you finish it. It will appear here with the time it was completed.')])]),
  ]));
  content.push(disclosure('progress-counting', 'How progress is counted', [note(data.coverage), data.recordedSince ? note(`History starts ${new Intl.DateTimeFormat('en-US', { timeZone: data.tz, dateStyle: 'medium' }).format(new Date(data.recordedSince))}. ${data.companyNote}`) : null]));
  if (data.automatedJobs?.count) content.push(el('details', { class: 'progress-panel' }, [
    el('summary', { text: `${data.automatedJobs.count} Zelos ${data.automatedJobs.count === 1 ? 'job' : 'jobs'} marked complete` }),
    note('These are background jobs, separate from your completed tasks. They are not included in completion totals or this PDF.'),
    el('ul', { class: 'progress-job-list' }, data.automatedJobs.entries.map(job => el('li', { text: job.title }))),
  ]));

  root.replaceChildren(...content); updateSelection();
}

export function renderProgress(ctx = {}) {
  cached.tz = ctx.tz || 'UTC';
  if (!cached.root) { cached.root = el('div', { class: 'view view-progress' }); load(); }
  else if (!cached.root.isConnected && !cached.loading) load();
  return cached.root;
}
