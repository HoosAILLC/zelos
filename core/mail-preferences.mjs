/** Explicit, account-scoped inbox preferences. Learning never leaves this home. */
import crypto from 'node:crypto';
import { getKV, setKV } from './db.mjs';

export const AUTO_DRAFT_KEY = 'mail.autoDrafts.enabled';
export function automaticDraftsEnabled(db) { return getKV(db, AUTO_DRAFT_KEY) === 'true'; }
export function mailPreferences(db) {
  return { automaticDrafts: automaticDraftsEnabled(db),
    rules: db.prepare('SELECT * FROM mail_rules ORDER BY updated_at DESC,id').all(),
    lastCheck: (() => { try { return JSON.parse(getKV(db, 'mail.autoDrafts.lastCheck')); } catch { return null; } })(),
    ready: db.prepare("SELECT count(*) AS n FROM mail_autodrafts a JOIN drafts d ON d.id=a.draft_id WHERE a.status='ready' AND d.state IN ('pending','edited')").get().n };
}
export function saveMailPreferences(db, input) {
  if (typeof input?.automaticDrafts !== 'boolean') throw Object.assign(new Error('Choose whether Zelos should prepare replies automatically.'), { status: 400 });
  setKV(db, AUTO_DRAFT_KEY, String(input.automaticDrafts));
  return mailPreferences(db);
}
export function forgetMailRule(db, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Choose a saved email rule.'), { status: 400 });
  db.prepare('DELETE FROM mail_rules WHERE id=?').run(id);
  return mailPreferences(db);
}
export function learnMailRule(db, message, { important, category, scope }) {
  if (scope === 'message') return null;
  const sender = String(message.from_email || '').trim().toLowerCase();
  if (!sender || !sender.includes('@')) return null;
  const kind = scope === 'sender' ? '*' : category;
  db.prepare(`INSERT INTO mail_rules(id,account_id,sender,category,important,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_id,sender,category) DO UPDATE SET important=excluded.important,updated_at=excluded.updated_at`)
    .run(crypto.randomUUID(), message.source_id, sender, kind, Number(important), new Date().toISOString());
  return { scope, category: kind };
}
