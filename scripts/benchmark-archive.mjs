// Synthetic-only, offline benchmark. Prints JSON and removes its temporary
// database. No real Zelos home or account is consulted.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-synthetic-50k-'));
process.env.ZELOS_HOME = path.join(scratch, 'home');
process.env.ZELOS_LOG_LEVEL = 'silent';
const importStarted = performance.now();
const dbm = await import('../core/db.mjs');
const moduleLoadMs = performance.now() - importStarted;
const file = path.join(scratch, 'synthetic.db');
const now = '2026-09-11T12:00:00Z';
let db;
const round = (n) => Math.round(n * 100) / 100;
function checkpointBytes() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return fs.statSync(file).size;
}
function measured(fn, repetitions = 15) {
  const samples = [];
  let count;
  for (let n = 0; n < repetitions; n++) {
    const start = performance.now();
    const rows = fn();
    samples.push(performance.now() - start);
    count = rows?.length;
  }
  samples.sort((a, b) => a - b);
  return { repetitions, medianMs: round(samples[Math.floor(samples.length / 2)]), p95Ms: round(samples[Math.ceil(samples.length * .95) - 1]), ...(count === undefined ? {} : { returnedRows: count }) };
}

try {
  const cleanStarted = performance.now();
  db = dbm.open(file); dbm.migrate(db);
  const cleanStartupMs = performance.now() - cleanStarted;
  const emptyBytes = checkpointBytes();
  const seedStarted = performance.now();
  const messageIds = [];
  for (let batch = 0; batch < 100; batch++) {
    const rows = Array.from({ length: 500 }, (_, index) => {
      const n = batch * 500 + index;
      return {
        sourceId: `synthetic-mail-${n % 5}`, uid: n + 1, messageId: `<synthetic-${n}@example.invalid>`,
        threadKey: `thread-${Math.floor(n / 4)}`, folder: 'INBOX', direction: n % 4 === 0 ? 'out' : 'in',
        from: { name: `Synthetic Sender ${n % 100}`, email: `person${n % 100}@example.invalid` },
        to: [{ name: 'Synthetic User', email: 'user@example.invalid' }],
        subject: `${n % 20 === 0 ? 'Invoice' : 'Project'} update ${n}`,
        date: new Date(Date.parse(now) - (n % 40) * 86400000 - n * 600).toISOString(),
        snippet: `Synthetic update ${n}: review the delivery schedule and confirm the appointment.`,
        text: (`Synthetic project ${n % 100}: review the delivery schedule and confirm the appointment. `).repeat(10),
        flags: ['\\Seen'],
      };
    });
    messageIds.push(...dbm.upsertMessages(db, rows, { now }).ids);
  }
  const seedMessagesMs = performance.now() - seedStarted;
  const messagesBytes = checkpointBytes();
  const items = Array.from({ length: 1000 }, (_, n) => ({
    key: `synthetic-item-${n}`, headline: `Review project ${n}`, why: 'A synthetic follow-up needs a decision.',
    bucket: ['today', 'soon', 'waiting', 'promised'][n % 4], severity: n % 4,
    dueAt: '2026-09-12', sourceRefs: [`msg:${messageIds[n]}`],
  }));
  const ids = [];
  dbm.withTransaction(db, () => {
    for (const item of items) ids.push(dbm.upsertItem(db, item, { now, runId: 'synthetic-run-1' }).id);
  });
  const itemsAndInitialHistoryBytes = checkpointBytes();
  const noOpBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM item_history').get().n);
  const unchangedSweep = measured(() => dbm.withTransaction(db, () => {
    for (const item of items) dbm.upsertItem(db, item, { now, runId: 'synthetic-unchanged' });
  }), 3);
  const noOpAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM item_history').get().n);
  if (noOpAfter !== noOpBefore) throw new Error('No-op sweeps created duplicate history');
  const noOpBytes = checkpointBytes();
  dbm.withTransaction(db, () => {
    for (const item of items) dbm.upsertItem(db, { ...item, dueAt: '2026-09-13', severity: 3 - item.severity }, { now, runId: 'synthetic-run-2' });
  });
  const changedHistoryBytes = checkpointBytes();
  const queries = {
    searchCommon: measured(() => dbm.search(db, 'project', { limit: 20 })),
    searchSelective: measured(() => dbm.search(db, 'Invoice', { limit: 20 })),
    searchMissing: measured(() => dbm.search(db, 'notfounduniquesynthetic', { limit: 20 })),
    listBoard: measured(() => dbm.listBoard(db, { now, limit: 500 })),
    listMessages: measured(() => dbm.listMessages(db, { sinceISO: '2026-08-21T00:00:00Z', limit: 500 })),
    itemHistory: measured(() => dbm.listItemHistory(db, ids[0], { limit: 20 }).entries),
  };
  dbm.close(db); db = null;
  const loadedStartup = measured(() => {
    db = dbm.open(file); dbm.migrate(db); dbm.close(db); db = null;
  }, 5);
  const results = {
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    fixture: { messages: 50000, items: 1000, historyEntries: 2000, bodyCharacters: 'approximately 800 per message', syntheticOnly: true },
    startup: { moduleLoadMs: round(moduleLoadMs), cleanOpenAndMigrateMs: round(cleanStartupMs), loadedOpenMigrateAndClose: loadedStartup },
    seedMessagesMs: round(seedMessagesMs), queries, unchanged1000ItemSweep: unchangedSweep,
    historyRowsAddedByThreeUnchangedSweeps: noOpAfter - noOpBefore,
    databaseBytesAfterCheckpoint: { empty: emptyBytes, messages: messagesBytes, itemsAndInitialHistory: itemsAndInitialHistoryBytes, unchangedSweeps: noOpBytes, changedHistory: changedHistoryBytes, growthFor1000Revisions: changedHistoryBytes - noOpBytes },
    limitations: 'Warm local-disk timings on this machine, without remote services or GUI. Reopening includes lease bookkeeping. This is a bounded synthetic smoke benchmark, not a concurrency or cold-cache guarantee.',
  };
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (db) dbm.close(db);
  fs.rmSync(scratch, { recursive: true, force: true });
}
