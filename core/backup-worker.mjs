/** Private desktop worker. The renderer cannot select an operation or path;
 * runtime.js starts this only after the native dialog and maintenance gate.
 * Keeping streaming copies and hashes off Electron's main thread lets the
 * window keep drawing and its quit/restore guards keep responding on big data.
 */
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, stageBackup, applyRestore } from './backup.mjs';

let db;
try {
  const { operation, args } = workerData;
  let result;
  if (operation === 'create') {
    // The parent holds the maintenance lease and has stopped every writer.
    // This connection is deliberately read-only and cannot publish a second
    // lease through db.open while that maintenance marker is held.
    db = new DatabaseSync(path.join(args.home, 'zelos.db'), { readOnly: true });
    result = createBackup({ ...args, db });
  } else if (operation === 'stage') {
    const staged = stageBackup(args);
    result = { id: staged.id, directory: staged.directory, manifest: staged.manifest };
  } else if (operation === 'apply') {
    result = applyRestore(args);
  } else throw new Error('Unknown backup operation');
  if (db) { db.close(); db = null; }
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message, code: err.code });
} finally {
  db?.close();
  parentPort.close();
}
