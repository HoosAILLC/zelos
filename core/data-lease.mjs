/** Cooperative exclusion for backup/restore, including long-lived stdio MCP.
 * Each open SQLite connection publishes a private lease BEFORE opening the DB.
 * Maintenance publishes its marker BEFORE checking leases. The second check
 * during registration closes the race between those operations. These are
 * separate from the older advisory desktop/CLI lock, which permits sharing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lockHolderState, readHomeLock } from './home-lock.mjs';

export const MAINTENANCE_FILE = '.data-maintenance';
const LEASE_DIR = '.data-connections';
const attached = new WeakMap();
function isHeld(value) { try { return lockHolderState(value).held; } catch { return true; } }
const error = () => Object.assign(new Error('Zelos is backing up or restoring data, or another Zelos/AI client still has this data open. Close other clients and try again.'), { code: 'ZELOS_DATA_BUSY' });
function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function read(file) {
  const st = stat(file);
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw error();
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw error(); }
  if (!Number.isInteger(record.pid) || record.pid <= 0 || !Number.isFinite(Date.parse(record.startedAt)) || !/^[a-f0-9-]{36}$/.test(record.id)) throw error();
  return record;
}
function record() { return { id: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), uid: process.getuid?.() ?? null }; }
function publish(file, value) {
  const temp = `${file}.${value.id}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // UUID destinations are never reused. A same-directory rename publishes
    // the complete record atomically without requiring hard-link support on
    // an external drive (the older advisory home lock can degrade there).
    if (stat(file)) throw error();
    fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temp, { force: true }); }
}
function removeOwned(file, id) {
  if (read(file)?.id === id) {
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
function ensureHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // A user-selected alias to an external drive was supported before leases.
  // Canonicalize that root; links INSIDE its private coordination directories
  // remain forbidden.
  const st = fs.statSync(home);
  if (!st.isDirectory()) throw error();
  return fs.realpathSync(home);
}

function ensurePrivate(dir) {
  if (!stat(dir)) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw error();
}
function records(dir) {
  if (!stat(dir)) return [];
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw error();
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw error();
    const file = path.join(dir, name);
    const value = read(file);
    if (value) {
      if (name !== `${value.id}.json`) throw error();
      found.push({ file, value });
    }
  }
  return found;
}

export function assertNoMaintenance(home) {
  for (const { value } of records(path.join(home, MAINTENANCE_FILE))) if (isHeld(value)) throw error();
  // A dead process may have left a partial restore. Only startup recovery is
  // allowed to open that home; a CLI/MCP must never see a half-replaced DB.
  if (stat(path.join(home, '.restore-journal.json'))) throw Object.assign(new Error('An interrupted restore needs recovery. Open the Zelos desktop app before using this data.'), { code: 'ZELOS_RESTORE_PENDING' });
}

export function registerDataConnection(dbPath) {
  if (dbPath === ':memory:') return { release() {} };
  const home = ensureHome(path.dirname(path.resolve(dbPath)));
  assertNoMaintenance(home);
  const dir = path.join(home, LEASE_DIR);
  ensurePrivate(dir);
  const value = record();
  const file = path.join(dir, `${value.id}.json`);
  publish(file, value);
  try { assertNoMaintenance(home); } catch (err) { removeOwned(file, value.id); throw err; }
  return { id: value.id, home, release: () => removeOwned(file, value.id) };
}
export function attachDataConnection(db, lease) { attached.set(db, lease); }
export function releaseDataConnection(db) { const lease = attached.get(db); lease?.release(); attached.delete(db); }

/** No force takeover: live, ambiguous, or unreadable leases all refuse. */
export function acquireMaintenance({ home, connection = null, recovering = false }) {
  home = ensureHome(home);
  const advisory = readHomeLock(home);
  if (advisory && advisory.pid !== process.pid && isHeld(advisory)) throw error();
  if (!recovering && stat(path.join(home, '.restore-journal.json'))) throw error();
  const value = record();
  const markers = path.join(home, MAINTENANCE_FILE);
  ensurePrivate(markers);
  const file = path.join(markers, `${value.id}.json`);
  publish(file, value);
  try {
    // Immutable UUID paths, never a reused singleton: reclaiming a dead
    // marker cannot unlink a later owner's marker. Concurrent contenders
    // publish first; they either see each other and back off, or one wins.
    for (const entry of records(markers)) {
      if (entry.value.id === value.id) continue;
      if (isHeld(entry.value)) throw error();
      removeOwned(entry.file, entry.value.id);
    }
    const own = connection ? attached.get(connection)?.id : null;
    const dir = path.join(home, LEASE_DIR);
    for (const entry of records(dir)) {
      if (entry.value.id === own) continue;
      if (isHeld(entry.value)) throw error();
      removeOwned(entry.file, entry.value.id);
    }
    return { release: () => removeOwned(file, value.id) };
  } catch (err) { removeOwned(file, value.id); throw err; }
}
