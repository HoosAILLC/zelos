/** Owner-only, explicit snapshots. Never mounted on the collaborator listener. */
import { createHash } from 'node:crypto';
import { FamilyError, familyAction } from './family.mjs';

const clean = (value, length = 8000) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, length);
const day = value => /^\d{4}-\d{2}-\d{2}/.test(value || '') ? value.slice(0, 10) : '';
const money = (cents, currency) => `${(Number(cents) / 100).toFixed(2)} ${clean(currency, 3)}`;
const line = (...parts) => parts.filter(value => value !== '' && value !== null && value !== undefined).map(value => clean(value)).join(' · ');
const json = value => { try { return JSON.parse(value); } catch { return {}; } };

function project(type, row) {
  if (!row) return null;
  let kind, title, details, date, sourceLabel, status = 'open';
  if (type === 'task') {
    kind = 'task'; title = row.headline; details = row.why; date = day(row.due_at); sourceLabel = 'Zelos task';
    status = row.state === 'done' ? 'done' : 'open';
  } else if (type === 'event') {
    kind = 'event'; title = row.title; date = day(row.starts_at); sourceLabel = 'Calendar event';
    details = [line(row.starts_at, row.ends_at), row.location, row.description].filter(Boolean).join('\n');
  } else if (type === 'transaction') {
    kind = 'note'; title = row.description; date = row.date; sourceLabel = 'Money transaction';
    details = [money(row.amount_cents, row.currency), line(row.kind, row.category, row.status)].join('\n');
  } else if (type === 'invoice') {
    kind = 'note'; title = line(`Invoice ${row.number}`, row.counterparty); date = row.due_date; sourceLabel = 'Money invoice';
    details = [row.description, money(row.amount_cents, row.currency), line(row.direction, row.status), `Issued ${row.issue_date} · Due ${row.due_date}`].filter(Boolean).join('\n');
  } else if (type === 'health') {
    const value = json(row.data_json);
    kind = row.kind === 'plan' ? 'plan' : 'tracking'; date = day(row.record_date || value.weekStart); sourceLabel = `Health ${row.kind}`;
    if (row.kind === 'walking') {
      title = 'Walking'; details = [line(value.steps == null ? '' : `${value.steps} steps`, value.distance == null ? '' : `${value.distance} ${value.distanceUnit || ''}`), value.note].filter(Boolean).join('\n');
    } else if (row.kind === 'metric' || row.kind === 'lab') {
      title = value.name || value.kind || 'Measurement';
      const numericReference=Number.isFinite(value.referenceLow)||Number.isFinite(value.referenceHigh)
        ? `Reference: ${Number.isFinite(value.referenceLow)?value.referenceLow:'—'} to ${Number.isFinite(value.referenceHigh)?value.referenceHigh:'—'} ${value.unit||''}` : '';
      details = [line(value.value, value.unit), value.note, value.referenceText, numericReference, value.lab, value.documentNote].filter(Boolean).join('\n');
    } else if (row.kind === 'plan') {
      title = value.title || 'Health plan';
      details = [value.note, ...(value.entries || []).map(entry => [
        line(entry.date,entry.kind,entry.mealSlot,entry.title,entry.state),
        line(entry.activity,entry.durationMinutes==null?'':`${entry.durationMinutes} minutes`,entry.intensity),
        entry.details,
        entry.ingredients?.length?`Ingredients: ${entry.ingredients.map(ingredient=>line(ingredient.quantity,ingredient.unit,ingredient.name)).join('; ')}`:'',
      ].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
    } else return null;
  } else return null;
  const completeDetails=clean(details,1_000_000),truncated=completeDetails.length>19_900;
  const result = {id:`${type}:${row.id}`,kind,title:clean(title || 'Untitled',200),details:clean(completeDetails,19_900)+(truncated?'\n\n[Long record: this snapshot contains only the first part shown here.]':''),date:date || '',status,sourceLabel,truncated};
  result.fingerprint = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}

const sources = {
  task: {table:'items', order:'updated_at DESC', where:"state NOT IN ('dismissed')"},
  event: {table:'events', order:'starts_at DESC', where:"status IS NULL OR status <> 'cancelled'"},
  health: {table:'health_records', order:'record_date DESC', where:"kind <> 'grocery'"},
  transaction: {table:'finance_transactions', order:'date DESC', where:"status <> 'excluded'"},
  invoice: {table:'finance_invoices', order:'due_date DESC', where:'1=1'},
};

export function familySources(db) {
  const records = [];
  for (const [type, spec] of Object.entries(sources)) {
    for (const row of db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.where} ORDER BY ${spec.order},id LIMIT 60`).all()) {
      const projected = project(type, row); if (projected) records.push(projected);
    }
  }
  return {sources:records,notice:'Choose a record to copy into Family. These are snapshots; later changes in the original are not shared automatically.',limitPerCategory:60};
}

export async function publishFamilySnapshot(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['sourceId','subjectId','visibility','fingerprint'].includes(key))) throw new FamilyError(400,'Choose a source record and its visibility.');
  if (typeof input.sourceId !== 'string' || input.sourceId.length > 200) throw new FamilyError(400,'Choose a source record.');
  const colon = input.sourceId.indexOf(':'), type = input.sourceId.slice(0,colon), id = input.sourceId.slice(colon+1), spec = Object.hasOwn(sources,type)?sources[type]:null;
  if (!spec || !id) throw new FamilyError(404,'This source record is not available.');
  const value = project(type, db.prepare(`SELECT * FROM ${spec.table} WHERE id=? AND (${spec.where})`).get(id));
  if (!value) throw new FamilyError(404,'This source record is not available.');
  // The source may have changed while its preview was open. Require a fresh
  // preview before copying new content the owner has not seen.
  if (input.fingerprint !== value.fingerprint) throw new FamilyError(409,'The source changed. Refresh its preview before copying it.');
  return familyAction(db,{accountId:'owner'},'record.save',{
    kind:value.kind,title:value.title,details:value.details,date:value.date,status:value.status,
    subjectId:input.subjectId || '',visibility:input.visibility || 'private',
    source:`Snapshot from ${value.sourceLabel} · ${new Date().toISOString()}`,
  });
}
