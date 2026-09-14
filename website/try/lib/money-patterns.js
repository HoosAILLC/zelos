/** Suggestions from recorded activity. This module never changes records or spending totals. */
const DAY = 86_400_000;
const MAX_DUPLICATE_PAIRS = 250;
const MAX_DUPLICATE_COMPARISONS = 50_000;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}

// SHA-256 is synchronous here so evidence keys are identical in the browser and server.
// Authorization still requires the server to reload and validate the referenced records.
const SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
export function stablePatternKey(parts) {
  const bytes = new TextEncoder().encode(stableJson(parts));
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer), bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + words[i]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+first)>>>0; d=c; c=b; b=a; a=(first+second)>>>0;
    }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) hash[i] = (hash[i] + value) >>> 0;
  }
  return [...hash].map(value => value.toString(16).padStart(8, '0')).join('');
}

function dayNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / DAY : null;
}
const isoDay = value => new Date(value * DAY).toISOString().slice(0, 10);
const rowOrder = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
function eligible(row) {
  return row && typeof row.id === 'string' && row.id && typeof row.entityId === 'string' && row.entityId
    && typeof row.accountId === 'string' && row.accountId && /^[A-Z]{3}$/.test(row.currency)
    && Number.isSafeInteger(row.amountCents) && row.amountCents !== 0 && dayNumber(row.date) !== null
    && row.status !== 'excluded' && row.status !== 'pending' && row.pending !== true && row.kind !== 'transfer';
}
function evidenceRows(rows) {
  const fields = ['id','entityId','accountId','currency','date','amountCents','category','status','kind','description','source','importSource','reference','updatedAt','pending'];
  return [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? null])));
}
function identity(type, rows, context) {
  const key = type + ':' + stablePatternKey({version: 1, context, rows: evidenceRows(rows)});
  return {id: key, key, rowIds: rows.map(row => row.id).sort()};
}

/** Retain store/reference digits; broad display aliases are not duplicate evidence. */
export function normalizeMoneyDescription(description) {
  return String(description ?? '').normalize('NFKC').trim().replace(/^AplPay\s+/i, '').replace(/^TST\*\s*/i, '')
    .split(/\s{2,}/)[0].replace(/\.(?:com|net|org)\b/gi, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function recurringMerchant(description) {
  const normalized = normalizeMoneyDescription(description);
  // These billers append changing transaction references. Keep the product-specific Uber One name.
  const names = [['NETFLIX', 'Netflix'], ['SPOTIFY', 'Spotify'], ['UBER ONE', 'Uber One'], ['COMCAST', 'Xfinity'], ['XFINITY', 'Xfinity']];
  const known = names.find(([prefix]) => normalized === prefix || normalized.startsWith(prefix + ' '));
  return known ? {key: known[1].toUpperCase(), name: known[1]} : {key: normalized, name: String(description ?? '').trim().replace(/^AplPay\s+/i, '').replace(/^TST\*\s*/i, '').split(/\s{2,}/)[0]};
}
const categorizedRecurring = row => /subscription|recurring/i.test(String(row.category ?? ''));
function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
function cadenceFor(rows) {
  const first = rows[0].date, days = rows.map(row => dayNumber(row.date));
  if (days.every((day, i) => !i || day - days[i - 1] >= 6 && day - days[i - 1] <= 8)
      && days.every((day, i) => Math.abs(day - days[0] - i * 7) <= 2)) {
    return {cadence: 'weekly', nextDate: isoDay(days.at(-1) + 7)};
  }
  const firstMonth = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7));
  for (const [cadence, months] of [['monthly', 1], ['quarterly', 3], ['annual', 12]]) {
    const fits = rows.every((row, i) => Number(row.date.slice(0, 4)) * 12 + Number(row.date.slice(5, 7)) - firstMonth === i * months
      && Math.abs(dayNumber(row.date) - dayNumber(addMonths(first, i * months))) <= 3);
    if (fits) return {cadence, nextDate: addMonths(first, rows.length * months)};
  }
  return null;
}

/** Inferred series remain suggestions; latest amount is an observed charge, never a monthly total. */
export function detectRecurring(transactions, {today = new Date().toISOString().slice(0, 10)} = {}) {
  const currentDay = dayNumber(today);
  if (currentDay === null) throw new Error('Choose a valid date for recurring-charge suggestions.');
  const groups = new Map();
  for (const row of transactions) {
    if (!eligible(row) || row.kind !== 'expense' || row.amountCents >= 0 || row.date > today) continue;
    const merchant = recurringMerchant(row.description);
    if (!merchant.key) continue;
    const key = stableJson([row.entityId, row.accountId, row.currency, merchant.key]);
    if (!groups.has(key)) groups.set(key, {merchant, rows: []});
    groups.get(key).rows.push(row);
  }
  const suggestions = [];
  for (const {merchant, rows} of groups.values()) {
    // A known category already has its own recurring section. Repeated IDs or same-day
    // charges are ambiguous evidence, including duplicated imports, so suppress that series.
    if (rows.length < 3 || rows.some(categorizedRecurring) || new Set(rows.map(row => row.id)).size !== rows.length
        || new Set(rows.map(row => row.date)).size !== rows.length) continue;
    rows.sort(rowOrder);
    const amounts = rows.map(row => -row.amountCents).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    if (amounts.at(-1) - amounts[0] > Math.floor(median * 0.05)) continue;
    const observed = cadenceFor(rows);
    if (!observed) continue;
    const newest = rows.at(-1), stale = observed.nextDate < today;
    const context = {entityId: newest.entityId, accountId: newest.accountId, currency: newest.currency, merchant: merchant.key, cadence: observed.cadence};
    suggestions.push({...identity('recurring', rows, context), ...context, name: merchant.name, rows: [...rows].reverse(),
      evidence: `${rows.length} similar charges at a roughly ${observed.cadence} interval on the same account.`,
      cadence: observed.cadence, latestAmountCents: -newest.amountCents, lastDate: newest.date,
      ...(!stale ? {estimatedNextDate: observed.nextDate} : {}), stale, suggestion: true});
  }
  return suggestions.sort((a, b) => Number(a.stale) - Number(b.stale) || b.lastDate.localeCompare(a.lastDate) || a.key.localeCompare(b.key));
}

function provenance(row) {
  if (typeof row.importSource === 'string') return row.importSource;
  if (row.source === 'bank' || row.source === 'plaid' || /^Plaid transaction \S/.test(row.reference ?? '')) return 'bank';
  return row.source;
}
function amexCard(account) {
  if (!account || account.type !== 'credit_card') return null;
  const name = String(account.name ?? '').normalize('NFKC').toUpperCase();
  const mask = /(?:[•·*#]\s*|ENDING\s+IN\s+)(\d{4,5})\s*$/.exec(name);
  if (!mask || !/\b(?:AMEX|AMERICAN EXPRESS)\b/.test(name)) return null;
  const product = name.slice(0, mask.index).replace(/\b(?:AMEX|AMERICAN EXPRESS|CARD|CREDIT)\b/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
  if (!product) return null;
  return {mask: mask[1].slice(-4), product};
}
function accountEvidence(a, b, accounts) {
  if (a.accountId === b.accountId) return {sameAccount: true};
  const leftSource = provenance(a), rightSource = provenance(b);
  if (!((leftSource === 'bank' && ['csv','document'].includes(rightSource)) || (rightSource === 'bank' && ['csv','document'].includes(leftSource)))) return null;
  const left = accounts.get(a.accountId), right = accounts.get(b.accountId);
  if (!left || !right || left.entityId !== a.entityId || right.entityId !== b.entityId || left.currency !== a.currency || right.currency !== b.currency) return null;
  const l = amexCard(left), r = amexCard(right);
  if (!l || !r || l.mask !== r.mask || l.product !== r.product) return null;
  return {sameAccount: false, mask: l.mask, product: l.product,
    accounts: [left, right].map(account => ({id: account.id, name: account.name, entityId: account.entityId, currency: account.currency, type: account.type})).sort((a, b) => a.id.localeCompare(b.id))};
}

/** Possible duplicate pairs only. Multiple matches stay visible and require a human choice. */
export function findDuplicateCandidates(transactions, {accounts = []} = {}) {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const groups = new Map(), idCounts = new Map();
  for (const row of transactions) if (eligible(row)) idCounts.set(row.id, (idCounts.get(row.id) || 0) + 1);
  for (const row of transactions) {
    if (!eligible(row) || idCounts.get(row.id) !== 1) continue;
    const description = normalizeMoneyDescription(row.description);
    if (!description) continue;
    const key = stableJson([row.entityId, row.currency, row.amountCents, description]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [], degree = new Map();
  let comparisons = 0, truncated = false;
  outer: for (const [descriptionKey, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort(rowOrder);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j], gap = dayNumber(b.date) - dayNumber(a.date);
        if (gap > 2) break;
        if (++comparisons > MAX_DUPLICATE_COMPARISONS) { truncated = true; break outer; }
        const account = accountEvidence(a, b, accountMap);
        if (!account) continue;
        if (candidates.length >= MAX_DUPLICATE_PAIRS) { truncated = true; break outer; }
        const pair = [a, b].sort((a, b) => a.id.localeCompare(b.id)), leftSource = provenance(a), rightSource = provenance(b);
        const differentSources = leftSource && rightSource && leftSource !== rightSource;
        const reason = account.sameAccount
          ? `Same account, signed amount and normalized description, ${gap === 0 ? 'on the same date' : `${gap} day${gap === 1 ? '' : 's'} apart`}. ${differentSources ? 'Recorded by different import sources.' : 'These may also be separate genuine transactions.'}`
          : `Matching Amex card product and last four digits across a statement and bank feed; same signed amount and normalized description within two days. Verify these account records represent the same card.`;
        candidates.push({...identity('duplicate', pair, {descriptionKey, account}), entityId: a.entityId,
          accountId: account.sameAccount ? a.accountId : null, currency: a.currency, rows: pair, reason,
          ambiguous: !account.sameAccount || !differentSources, suggestion: true});
        for (const row of pair) degree.set(row.id, (degree.get(row.id) || 0) + 1);
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.rowIds.some(id => degree.get(id) > 1)) {
      candidate.ambiguous = true;
      candidate.reason += ' At least one record has more than one possible match.';
    }
  }
  // The array contract stays convenient for UI callers while disclosing a bounded scan.
  if (truncated) Object.defineProperty(candidates, 'truncated', {value: true, enumerable: true});
  return candidates;
}
