import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, migrate, close, setKV, getKV } from '../core/db.mjs';
import { DEFAULTS } from '../core/config.mjs';
import { runAutomaticBackup } from '../core/automatic-backup.mjs';
import { stageBackup } from '../core/backup.mjs';
import { recoverAutomaticBackup } from '../scripts/recover-automatic-backup.mjs';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-recovery-test-')));
  const home = path.join(dir, 'synthetic-home'); fs.mkdirSync(home, { mode: 0o700 });
  const db = open(path.join(home, 'zelos.db')); migrate(db);
  setKV(db, 'synthetic.fact', 'Preserve this synthetic record');
  const config = structuredClone(DEFAULTS);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const backup = runAutomaticBackup({ db, home, config, appVersion: '1.8.4', force: true });
  const source = path.join(home, 'backups', 'automatic', backup.last.filename);
  const keyFile = path.join(home, '.automatic-backup-key');
  const destination = path.join(dir, 'recovered.zelos-backup');
  t.after(() => { close(db); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, db, source, keyFile, destination };
}

test('recovery publishes a valid private archive without replacing live data', t => {
  const f = fixture(t);
  assert.equal(recoverAutomaticBackup(f).ok, true);
  assert.equal(getKV(f.db, 'synthetic.fact'), 'Preserve this synthetic record');
  const staged = stageBackup({ home: f.home, source: f.destination });
  const copy = open(path.join(staged.directory, 'new', 'zelos.db'));
  try { assert.equal(getKV(copy, 'synthetic.fact'), 'Preserve this synthetic record'); }
  finally { close(copy); staged.cleanup(); }
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.destination).nlink, 1);
  assert.ok(!fs.readdirSync(f.dir).some(name => name.startsWith('.zelos-backup-recovery-')));
});

test('an output created during recovery is never overwritten and temporary plaintext is removed', t => {
  const f = fixture(t), original = fs.linkSync;
  let interleaved = false;
  t.mock.method(fs, 'linkSync', function (from, to) {
    if (to === f.destination) {
      interleaved = true;
      fs.writeFileSync(to, 'New unrelated file created during recovery', { flag: 'wx', mode: 0o600 });
    }
    return original.call(fs, from, to);
  });
  assert.throws(() => recoverAutomaticBackup(f), { code: 'EEXIST' });
  assert.equal(interleaved, true, 'the race must occur at the actual atomic publication point');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'New unrelated file created during recovery');
  assert.equal(getKV(f.db, 'synthetic.fact'), 'Preserve this synthetic record');
  assert.ok(!fs.readdirSync(f.dir).some(name => name.startsWith('.zelos-backup-recovery-')));
});

test('existing output bytes and dangling symlinks cannot be replaced', { skip: process.platform === 'win32' && 'Synthetic dangling symlink requires POSIX permissions.' }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.destination, 'Existing unrelated output');
  assert.throws(() => recoverAutomaticBackup(f), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'Existing unrelated output');
  fs.unlinkSync(f.destination);
  const absent = path.join(f.dir, 'do-not-create'); fs.symlinkSync(absent, f.destination);
  assert.throws(() => recoverAutomaticBackup(f), { code: 'EEXIST' });
  assert.equal(fs.readlinkSync(f.destination), absent);
  assert.equal(fs.existsSync(absent), false);
});
