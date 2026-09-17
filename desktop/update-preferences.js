import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function updatePreferences(file) {
  return {
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { automatic: value.automatic === true,
          lastNotifiedVersion: typeof value.lastNotifiedVersion === 'string' ? value.lastNotifiedVersion : '' };
      } catch (error) {
        // A damaged/unreadable existing choice must not turn checking back on.
        return { automatic: error.code === 'ENOENT', lastNotifiedVersion: '' };
      }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
  };
}
