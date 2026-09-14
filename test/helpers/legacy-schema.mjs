import assert from 'node:assert/strict';

/** Reconstruct a v2-v4 synthetic fixture, preserving its legacy tables and rows.
 * Removing only the original v5 changes leaves later modules behind and does
 * not represent a database an older release could have created.
 */
export function restoreLegacySchema(db, version) {
  assert.ok([2, 3, 4].includes(version), 'This fixture supports schema versions 2–4 only.');
  const keep = new Set(['messages', 'events', 'items', 'drafts', 'captures', 'runs', 'kv', 'search']);
  if (version >= 3) keep.add('task_activity');
  if (version >= 4) keep.add('item_history');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    // Shadow tables belong to their virtual table and must not be dropped separately.
    for (const { name, type } of db.prepare('PRAGMA main.table_list').all()) {
      if (['table', 'virtual'].includes(type) && !name.startsWith('sqlite_') && !keep.has(name)) {
        db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
      }
    }
    for (const column of ['reply_to_json', 'references_json', 'in_reply_to', 'reply_headers_known']) {
      db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    }
    if (version < 4) db.prepare('DELETE FROM kv WHERE k=?').run('itemHistory.startedAt');
    db.exec(`PRAGMA user_version = ${version}`);
  } finally { db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
  const tables = db.prepare('PRAGMA main.table_list').all()
    .filter(row => ['table', 'virtual'].includes(row.type) && !row.name.startsWith('sqlite_')).map(row => row.name);
  assert.deepEqual(new Set(tables), keep, 'Only tables from the selected historical schema remain.');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}
