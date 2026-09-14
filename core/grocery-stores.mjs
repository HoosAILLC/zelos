/** Local shopping preferences, separate from provider credentials and checkout. */
import { randomUUID } from 'node:crypto';

export class GroceryStoresError extends Error {
  constructor(status, message) { super(message); this.name = 'GroceryStoresError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new GroceryStoresError(status, message); };
const key = 'shopping.preferredStores';
export const GROCERY_STORES = Object.freeze([
  ['costco', 'Costco'], ['kroger', 'Kroger'], ['meijer', 'Meijer'],
  ['aldi', 'ALDI'], ['walmart', 'Walmart'], ['target', 'Target'],
  ['trader-joes', 'Trader Joe’s'], ['whole-foods', 'Whole Foods Market'],
  ['sams-club', 'Sam’s Club'], ['publix', 'Publix'],
].map(([id, name]) => Object.freeze({ id, name })));
const note = 'Used for meal planning. Prices and availability are estimates, not checked store quotes. Full packages may cost more than the amount used.';
const read = db => db.prepare('SELECT v FROM kv WHERE k=?').get(key)?.v ?? null;
const parse = raw => {
  if (!raw) return { storeIds: [], revision: null, updatedAt: null };
  const value = JSON.parse(raw);
  if (!Array.isArray(value.storeIds) || value.storeIds.some(id => !GROCERY_STORES.some(s => s.id === id))) fail('Saved store preferences need to be selected again.', 409);
  return value;
};
const present = value => ({
  stores: value.storeIds.map(id => ({ ...GROCERY_STORES.find(s => s.id === id) })),
  availableStores: GROCERY_STORES.map(s => ({ ...s })),
  revision: value.revision, updatedAt: value.updatedAt, note,
});

export function getGroceryStores(db) { return present(parse(read(db))); }

/** A strict revision check keeps changes from another device from being lost. */
export function saveGroceryStores(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['storeIds', 'expectedRevision'].includes(k))) fail('Choose your grocery stores.');
  if (!Array.isArray(input.storeIds) || input.storeIds.length > GROCERY_STORES.length || new Set(input.storeIds).size !== input.storeIds.length || input.storeIds.some(id => typeof id !== 'string' || !GROCERY_STORES.some(s => s.id === id))) fail('Choose stores from the available list.');
  const raw = read(db), previous = parse(raw);
  if (!Object.hasOwn(input, 'expectedRevision') || input.expectedRevision !== previous.revision) fail('Your preferred stores changed on another device. Reload before saving.', 409);
  // These are an unordered set; a repeated save needs no new revision.
  const storeIds = GROCERY_STORES.filter(s => input.storeIds.includes(s.id)).map(s => s.id);
  if (JSON.stringify(storeIds) === JSON.stringify(previous.storeIds)) return present(previous);
  const next = { storeIds, revision: randomUUID(), updatedAt: new Date().toISOString() };
  const result = raw === null
    ? db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING').run(key, JSON.stringify(next))
    : db.prepare('UPDATE kv SET v=? WHERE k=? AND v=?').run(JSON.stringify(next), key, raw);
  if (result.changes !== 1) fail('Your preferred stores changed on another device. Reload before saving.', 409);
  return present(next);
}
