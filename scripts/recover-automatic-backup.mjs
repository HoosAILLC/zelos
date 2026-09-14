#!/usr/bin/env node
/** Decrypt and validate a recovery copy without replacing live Zelos data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stageEncryptedBackup } from '../core/automatic-backup.mjs';
import { createBackup } from '../core/backup.mjs';

export function recoverAutomaticBackup({ source, keyFile, destination }) {
  destination = path.resolve(destination);
  const parent = fs.realpathSync(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-backup-recovery-'));
  fs.chmodSync(scratch, 0o700);
  let staged, db, publication;
  try {
    staged = stageEncryptedBackup({ home: scratch, source: path.resolve(source), keyFile: path.resolve(keyFile) });
    const home = path.join(staged.directory, 'new');
    db = new DatabaseSync(path.join(home, 'zelos.db'));
    // A private same-directory stage keeps publication on one filesystem.
    // linkSync creates the final directory entry atomically and fails if any
    // file, directory or dangling symlink already occupies the chosen name.
    // Never use rename here: it can replace a file created while we decrypted.
    publication = fs.mkdtempSync(path.join(parent, '.zelos-backup-recovery-'));
    fs.chmodSync(publication, 0o700);
    const verified = path.join(publication, 'verified.zelos-backup');
    createBackup({ home, db, destination: verified, appVersion: staged.manifest.appVersion,
      config: JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) });
    fs.linkSync(verified, destination);
    fs.unlinkSync(verified);
    return { ok: true, destination };
  } finally {
    db?.close(); staged?.cleanup();
    if (publication) fs.rmSync(publication, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [source, keyFile, destination, ...extra] = process.argv.slice(2);
  if (!source || !keyFile || !destination || extra.length) {
    console.error('Usage: node scripts/recover-automatic-backup.mjs ENCRYPTED_BACKUP RECOVERY_KEY NEW_OUTPUT.zelos-backup');
    process.exitCode = 2;
  } else {
    try {
      recoverAutomaticBackup({ source, keyFile, destination });
      console.log('Verified recovery archive created. Keep it private: this output is decrypted. Live Zelos data was not changed.');
    } catch (error) {
      console.error(error.code === 'EEXIST'
        ? 'Choose a new output filename. Existing files are never replaced.'
        : 'Recovery failed. Check the backup, key and output folder. Live Zelos data was not changed.');
      process.exitCode = 1;
    }
  }
}
