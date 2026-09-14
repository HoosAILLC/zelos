/** Read-only saved Health evidence for Ask. No model, network, or preview imports. */
import { cap, scrubForPrompt } from './safety.mjs';

const KINDS = ['profile', 'lab', 'walking', 'metric', 'plan', 'grocery'];
const PROFILE_FIELDS = ['goals', 'diet', 'allergies', 'exerciseLimitations', 'weeklyBudget', 'currency', 'householdSize'];
const RECORD_FIELDS = {
  lab: ['date', 'name', 'value', 'unit', 'referenceLow', 'referenceHigh', 'referenceText', 'lab', 'documentNote'],
  walking: ['date', 'steps', 'distance', 'distanceUnit', 'distanceKm', 'note', 'source'],
  metric: ['date', 'kind', 'value', 'unit', 'baseValue', 'note'],
  plan: ['title', 'weekStart', 'note', 'entries'],
  grocery: ['planId', 'entryId', 'name', 'quantity', 'estimatedCost', 'state'],
};
const ENTRY_FIELDS = ['id', 'date', 'kind', 'title', 'details', 'state', 'mealSlot', 'ingredients', 'durationMinutes', 'intensity', 'activity'];
const DIRECT = /\b(?:health|medical|labs?|labwork|bloodwork|blood\s+(?:test|tests|work|results?|pressure|sugar)|walking|walked|walks|sleep|sleeping|slept|weight|weigh|nutrition|nutritional|diet|dietary|meals?|workouts?|exercise|fitness|allergies|allergy|cholesterol|a1c|hba1c|vitamins?|calories|protein|groceries|grocery|biomarkers?|symptoms?|wellness)\b|\b(?:my|saved|health)\s+(?:health\s+)?profile\b|\b(?:step count|daily steps|my steps|steps today|how many steps)\b/i;
const INVENTORY = /\bwhat\b.*\b(?:know about me|(?:records|data|information).*(?:have|access|saved|see|stored))\b|\b(?:can|could|do) you (?:see|read|access)\b.*\b(?:results|records|data|uploads|uploaded)\b|\b(?:show|list) (?:me )?(?:all )?(?:my|the saved) (?:records|data|information)\b/i;
const LAB_QUALIFIER = /\b(?:my|lab|labs|blood|test|tests|result|results|level|levels|value|values|reading|readings|high|low|normal|range|ranges)\b/i;
const GENERIC_NAME_WORDS = new Set(['test', 'tests', 'level', 'levels', 'result', 'results', 'value', 'values', 'total', 'serum', 'plasma', 'blood', 'urine', 'panel', 'count', 'ratio', 'calculated', 'direct', 'with', 'without', 'reference', 'range', 'name']);
const normalize = value => scrubForPrompt(typeof value === 'string' ? value : '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hasPhrase = (haystack, needle) => needle && ` ${haystack} `.includes(` ${needle} `);
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const parse = value => { try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; } };
const counts = () => Object.fromEntries(KINDS.map(kind => [kind, 0]));

function nameMatches(question, name) {
  const q = normalize(question), full = normalize(name);
  if (!q || !full) return false;
  const words = full.split(' '), useful = words.filter(word => !GENERIC_NAME_WORDS.has(word));
  if (!useful.length) return false;
  // Short/common names such as ALT, Na, iron, or TSH need a health qualifier.
  if (hasPhrase(q, full) && (full.replace(/ /g, '').length >= 5 || LAB_QUALIFIER.test(question))) return true;
  return useful.some(word => word.length >= 5 && hasPhrase(q, word));
}

function directHealth(db, question) {
  if (DIRECT.test(question) || INVENTORY.test(question) || (/\bplans?\b/i.test(question) && /\b(?:my|saved|stored|have I|did I)\b/i.test(question))) return true;
  if (!hasTable(db, 'health_records')) return false;
  for (const row of db.prepare("SELECT data_json FROM health_records WHERE kind='lab'").all()) {
    if (nameMatches(question, parse(row.data_json)?.name)) return true;
  }
  return false;
}

function followup(question) {
  const q = question.trim();
  if (!q || q.length > 400) return false;
  if (/\b(?:weather|emails?|calendar|invoices?|bookings?|stocks?|javascript|python|flights?|hotels?|movies?|music|football|website|bitcoin)\b/i.test(q)) return false;
  return /^(?:yes|no|why|continue|go on|tell me more|explain(?: more| that| those| these| it)?|what next|what changed|compare (?:them|those|these|to last time)|what should I do|how can I improve)[.!?\s]*$/i.test(q)
    || /^(?:what|which|how|why|is|are|can|could|should|would|do|does)\b.*\b(?:that|those|these|they|them|it|ones|out of range|concerning)\b/i.test(q);
}

/** Followups inherit only a recent completed health turn, not arbitrary earlier
 * topics. The caller separately enforces privacy for already-sent history. */
export function needsHealthContext(db, question, priorMessages = []) {
  const q = typeof question === 'string' ? question.slice(0, 12000) : '';
  if (directHealth(db, q)) return true;
  if (!followup(q)) return false;
  const prior = (Array.isArray(priorMessages) ? priorMessages : []).filter(message =>
    message && ['user', 'assistant'].includes(message.role) && (!message.state || message.state === 'complete')).slice(-12);
  if (prior.at(-1)?.role === 'user' && prior.at(-1).content?.trim() === q.trim()) prior.pop();
  for (let index = prior.length - 1; index >= 0; index--) {
    const message = prior[index];
    if (message.role === 'assistant') {
      if (Array.isArray(message.sources) && message.sources.some(source => source?.kind === 'health' || String(source?.ref || '').startsWith('health:'))) return true;
    } else {
      const text = typeof message.content === 'string' ? message.content.slice(0, 12000) : '';
      if (directHealth(db, text)) return true;
      if (!followup(text)) return false;
    }
  }
  return false;
}

function sanitize(value) {
  if (typeof value === 'string') return scrubForPrompt(value).replaceAll('ZELOS-UNTRUSTED', 'ZELOS_UNTRUSTED_LITERAL');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
const pick = (object, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(object, field)).map(field => [field, object[field]]));
const oneLine = value => scrubForPrompt(String(value ?? '')).replace(/\s+/g, ' ').replaceAll('ZELOS-UNTRUSTED', 'ZELOS_UNTRUSTED_LITERAL');

function candidate(kind, row, input) {
  const data = pick(input, kind === 'profile' ? PROFILE_FIELDS : RECORD_FIELDS[kind]);
  if (kind === 'plan' && Array.isArray(data.entries)) data.entries = data.entries.map(entry => {
    const saved = pick(entry, ENTRY_FIELDS);
    if (Array.isArray(saved.ingredients)) saved.ingredients = saved.ingredients.map(ingredient => pick(ingredient, ['name', 'quantity', 'unit']));
    return saved;
  });
  if (kind !== 'profile') { data.id = row.id; data.createdAt = row.created_at; }
  data.updatedAt = row.updated_at;
  const title = kind === 'profile' ? 'Saved health profile'
    : kind === 'lab' ? `Lab: ${input.name || 'Unnamed observation'} — ${input.date || 'Date not recorded'}`
      : kind === 'walking' ? `Walking — ${input.date || 'Date not recorded'}`
        : kind === 'metric' ? `${input.kind === 'sleep' ? 'Sleep' : 'Weight'} — ${input.date || 'Date not recorded'}`
          : kind === 'plan' ? `Saved plan: ${input.title || 'Untitled'} — ${input.weekStart || ''}` : `Grocery: ${input.name || 'Unnamed item'}`;
  const ref = kind === 'profile' ? 'health:profile' : `health:${kind}:${encodeURIComponent(row.id)}`;
  const safeData = sanitize(data), safeTitle = cap(oneLine(title), 200);
  const json = JSON.stringify({ recordType: kind, saved: true, data: safeData });
  return { kind, data: safeData, stamp: Date.parse(row.record_date || input.date || input.weekStart || row.updated_at) || 0,
    source: { kind: 'health', ref, title: safeTitle, excerpt: cap(oneLine(JSON.stringify(safeData)), 240) },
    block: `[${ref}] ${safeTitle}\n${json}` };
}

function priority(entry, question) {
  if (entry.kind === 'lab' && nameMatches(question, entry.data.name)) return 1000;
  if (entry.kind === 'lab' && /\b(?:labs?|labwork|bloodwork|blood|results?|biomarkers?)\b/i.test(question)) return 600;
  if (entry.kind === 'walking' && /\b(?:walking|walked|walks|steps|distance)\b/i.test(question)) return 600;
  if (entry.kind === 'metric' && new RegExp(`\\b(?:${entry.data.kind === 'sleep' ? 'sleep|sleeping|slept' : 'weight|weigh'})\\b`, 'i').test(question)) return 600;
  if (entry.kind === 'plan' && /\b(?:meals?|workouts?|exercise|nutrition|diet|plans?|eating)\b/i.test(question)) return 600;
  if (entry.kind === 'grocery' && /\b(?:groceries|grocery|shopping|ingredients?)\b/i.test(question)) return 600;
  if (entry.kind === 'profile') return /\b(?:profile|goals?|allergies|diet|preferences|limitations|budget)\b/i.test(question) ? 700 : 100;
  return 0;
}

function summary(saved, selected, unreadable, tablesPresent) {
  const included = counts(); for (const entry of selected) included[entry.kind]++;
  const omitted = Object.fromEntries(KINDS.map(kind => [kind, saved[kind] - included[kind]]));
  const total = Object.values(saved).reduce((sum, value) => sum + value, 0);
  const excerpt = `${saved.lab} saved lab results; ${saved.walking} walking records; ${saved.metric} measurements; ${saved.plan} plans; ${saved.grocery} groceries; profile ${saved.profile ? 'saved' : 'not saved'}. Included ${selected.length} of ${total}; omitted ${total - selected.length}.`;
  const facts = { saved, included, omitted, unreadable, unsavedPreviewsExcluded: true, healthTablesPresent: tablesPresent };
  const source = { kind: 'health', ref: 'health:summary', title: 'Saved Health records', excerpt: cap(excerpt, 240) };
  const block = `[health:summary] Saved Health records\n${excerpt}\n${JSON.stringify(facts)}\nValues are saved observations, not diagnoses. Null or empty means not recorded. Saved plans are intentions; only an entry marked done records completion. Counts exclude unsaved document previews. Omitted records are not evidence of missing data.`;
  return { source, block, total };
}

/** Fresh whole-record snapshot. The caller wraps this scrubbed context as
 * untrusted data. No defaults or unsaved document rows become saved evidence. */
export function healthChatContext(db, { question = '', maxChars = 24000, maxRecords = 80 } = {}) {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.min(96000, Math.floor(maxChars))) : 24000;
  const limit = Number.isFinite(maxRecords) ? Math.max(0, Math.min(500, Math.floor(maxRecords))) : 80;
  const saved = counts(), candidates = [], tablesPresent = hasTable(db, 'health_records') && hasTable(db, 'health_profile');
  let unreadable = 0;
  if (hasTable(db, 'health_profile')) {
    const row = db.prepare('SELECT data_json,updated_at FROM health_profile WHERE id=1').get();
    if (row?.updated_at) { saved.profile = 1; const data = parse(row.data_json); if (data) candidates.push(candidate('profile', row, data)); else unreadable++; }
  }
  if (hasTable(db, 'health_records')) {
    for (const row of db.prepare('SELECT id,kind,record_date,data_json,created_at,updated_at FROM health_records ORDER BY record_date DESC,updated_at DESC,id').all()) {
      if (!Object.hasOwn(RECORD_FIELDS, row.kind)) continue;
      saved[row.kind]++;
      const data = parse(row.data_json);
      if (data) { try { candidates.push(candidate(row.kind, row, data)); } catch { unreadable++; } } else unreadable++;
    }
  }
  const q = typeof question === 'string' ? question.slice(0, 12000) : '';
  candidates.sort((a, b) => priority(b, q) - priority(a, q) || b.stamp - a.stamp || a.source.ref.localeCompare(b.source.ref));
  const selected = [];
  const assemble = entries => {
    const header = summary(saved, entries, unreadable, tablesPresent);
    return { header, context: [header.block, ...entries.map(entry => entry.block)].join('\n\n') };
  };
  for (const entry of candidates) {
    if (selected.length >= limit) break;
    if (assemble([...selected, entry]).context.length <= budget) selected.push(entry);
  }
  const result = assemble(selected);
  if (result.context.length <= budget) return { sources: [result.header.source, ...selected.map(entry => entry.source)], context: result.context };
  // Very small caller budgets still receive honest totals when a complete
  // compact summary fits. No record or JSON object is cut in the middle.
  const compact = `[health:summary] Saved ${result.header.total} Health records; included 0; omitted ${result.header.total}. Unsaved previews excluded.`;
  return compact.length <= budget ? { sources: [result.header.source], context: compact } : { sources: [], context: '' };
}
