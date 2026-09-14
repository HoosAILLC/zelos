import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';
let sequence = 0;
const base = {
  week: '2026-09-07', start: '2026-09-07', end: '2026-09-13', tz: 'America/Indiana/Indianapolis', reopened: 1,
  coverage: 'Recorded Done changes only.', recordedSince: '2026-09-01T12:00:00Z', companyNote: 'Current company labels.',
  totals: { completed: 1, activeDays: 1, daily: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((label, index) => ({ label, date: `2026-09-${String(index + 7).padStart(2,'0')}`, count: index === 1 ? 1 : 0 })), buckets: [{ label: 'Today', count: 1 }], companies: [{ label: 'Studio', count: 1 }] },
  entries: [{ id: 'done', title: 'Finish the brief <img onerror=bad>', status: 'completed', description: 'Private context', day: '2026-09-08', completedAt: '2026-09-08T10:00:00-04:00', bucketLabel: 'Today', company: 'Studio', completionEvents: 1 },
    { id: 'reopened', title: 'Reopened plan', status: 'reopened', description: '', day: '2026-09-08', completedAt: '2026-09-08T11:00:00-04:00', bucketLabel: 'Today', company: 'Unassigned', completionEvents: 1 }],
};
async function fixture(t, data = base) {
  const document = installDom(t), { api } = await import('../ui/lib/api.js');
  const calls = [];
  const previous = { progress: api.progress, progressPdf: api.progressPdf };
  api.progress = async value => { calls.push({ type: 'read', value }); return structuredClone(data); };
  api.progressPdf = async value => { calls.push({ type: 'pdf', value }); return new Blob(['%PDF-fake'], { type: 'application/pdf' }); };
  t.after(() => Object.assign(api, previous));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = await import(`../ui/views/progress.js?test=${++sequence}`);
  const view = document.body.appendChild(module.renderProgress({ tz: data.tz }));
  await settle();
  return { view, calls, document, api };
}
test('progress renders source text safely, selects completed work and disables reopened export choices', async t => {
  const { view, calls } = await fixture(t);
  assert.equal(view.querySelectorAll('img').length, 0);
  assert.match(text(view), /Finish the brief <img onerror=bad>/);
  assert.equal(view.querySelector('[aria-label="Include Finish the brief <img onerror=bad> in the report"]').checked, true);
  assert.equal(view.querySelector('[aria-label="Include Reopened plan in the report"]').disabled, true);
  assert.equal(view.querySelector('[aria-label="Include descriptions"]').checked, false);
  assert.equal(calls.filter(call => call.type === 'pdf').length, 0);
});
test('weekly PDF receives the reviewed selection and privacy options, with an editable title', async t => {
  const { view, calls } = await fixture(t);
  const title = view.querySelector('[aria-label="Report title"]'); title.value = 'My public weekly update'; title.fire('input');
  const titles = view.querySelector('[aria-label="Include task titles"]'); titles.checked = false; titles.fire('change');
  assert.equal(view.querySelector('[aria-label="Include descriptions"]').disabled, true);
  findButton(view, 'Clear selection').click();
  assert.match(text(view), /0 completed tasks selected/);
  findButton(view, 'Download weekly PDF').click(); await settle();
  assert.deepEqual(calls.find(call => call.type === 'pdf').value, { week: '2026-09-07', selectedIds: [], title: 'My public weekly update', includeTitles: false, includeDetails: false, includeCompanies: false });
});
test('a failed report download shows its error and offers another download', async t => {
  const { view, api } = await fixture(t);
  api.progressPdf = async () => { throw new Error('The selected task was reopened. Refresh and review the selection.'); };
  findButton(view, 'Download weekly PDF').click(); await settle();
  assert.match(text(view.querySelector('[role="alert"]')), /reopened/);
  assert.equal(findButton(view, 'Download weekly PDF').disabled, false);
});
test('an empty week is honest and never renders fake completed work', async t => {
  const empty = structuredClone(base); empty.entries = []; empty.totals.completed = 0; empty.reopened = 0;
  const { view } = await fixture(t, empty);
  assert.match(text(view), /No recorded completions this week/);
  assert.equal(view.querySelectorAll('.progress-item').length, 0);
});
