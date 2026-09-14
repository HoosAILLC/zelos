/** Authenticator factors: password-sealed storage and memory-only, expiring authentication challenges. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt), TTL = 5 * 60000;
const challenges = new WeakMap();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const nowISO = () => new Date().toISOString();
export class FamilyMfaError extends Error {
  constructor(status, message) { super(message); this.status = status; this.name = 'FamilyMfaError'; }
}
const fail = (status, message) => { throw new FamilyMfaError(status, message); };
function equal(a, b) { return crypto.timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex')); }

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]{16,128}$/.test(value)) throw new TypeError('Invalid authenticator key.');
  let bits = 0, number = 0; const out = [];
  for (const char of value) { number = (number << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { out.push((number >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(seed, counter, digits, algorithm) {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algorithm, seed).update(bytes).digest(), offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
/** RFC 6238 primitive. Millisecond time; SHA-1/six digits for authenticator interoperability. */
export function totpCode(secret, { time = Date.now(), digits = 6, algorithm = 'sha1', period = 30 } = {}) {
  if (!Number.isFinite(time) || time < 0 || ![6, 8].includes(digits) || !['sha1', 'sha256', 'sha512'].includes(algorithm)
      || !Number.isSafeInteger(period) || period < 1) throw new TypeError('Invalid authenticator parameters.');
  return hotp(base32Decode(secret), Math.floor(time / 1000 / period), digits, algorithm);
}
function matchingCounter(seed, code, lastCounter) {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(Date.now() / 30000); let found = null;
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (candidate >= 0 && equal(hotp(seed, candidate, 6, 'sha1'), code) && candidate > lastCounter) found = candidate;
  }
  return found;
}

export function migrateFamilyMfa(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS family_mfa (
      account_id TEXT PRIMARY KEY REFERENCES family_accounts(id), salt TEXT NOT NULL, sealed TEXT NOT NULL,
      recovery_json TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1, version TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_mfa_limits (
      account_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, blocked_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_http_auth_limits (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, requests INTEGER NOT NULL
    );`);
}
const factor = (db, accountId) => db.prepare('SELECT * FROM family_mfa WHERE account_id=?').get(accountId) || null;
export function hasFamilyMfa(db, accountId) { return !!factor(db, accountId); }
function aad(accountId) { return Buffer.from(`Zelos family authenticator v1:${accountId}`, 'utf8'); }
async function keyFor(password, salt, accountId) {
  if (typeof password !== 'string' || password.length > 128 || !/^[a-f0-9]{32}$/.test(salt)) fail(401, 'The authenticator could not be unlocked. Sign in again.');
  return scrypt(password, Buffer.concat([aad(accountId), Buffer.from(salt, 'hex')]), 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
}
function seal(seed, key, accountId) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(accountId));
  const bytes = Buffer.concat([cipher.update(seed), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: bytes.toString('base64') });
}
function unlock(encoded, key, accountId) {
  try {
    const value = JSON.parse(encoded), iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64'), body = Buffer.from(value.body, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || body.length !== 20) throw new Error('Invalid factor.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(accountId)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch { fail(401, 'The authenticator could not be unlocked. Sign in again.'); }
}
export function familyAuthSnapshot(account) {
  return sha(JSON.stringify([account.id, account.email, account.role, account.status, account.password_hash, account.updated_at]));
}
function mapFor(db) { if (!challenges.has(db)) challenges.set(db, new Map()); return challenges.get(db); }
function destroy(value) { clearTimeout(value.timer); value.seed?.fill(0); value.key?.fill(0); }
function cleanup(db) {
  const map = mapFor(db);
  for (const [key, value] of map) if (value.expires <= Date.now()) { destroy(value); map.delete(key); }
}
function issue(db, value) {
  cleanup(db); const map = mapFor(db);
  const previous = [...map].filter(([, entry]) => entry.accountId === value.accountId);
  for (const [key, entry] of previous.slice(0, Math.max(0, previous.length - 2))) { destroy(entry); map.delete(key); }
  if (map.size >= 100) { destroy(value); fail(429, 'Too many sign-in attempts. Wait a few minutes and try again.'); }
  const challenge = `zfc_${crypto.randomBytes(32).toString('base64url')}`, expires = Date.now() + TTL;
  const id = sha(challenge), entry = { ...value, expires, attempts: 0 };
  entry.timer = setTimeout(() => { if (map.get(id) === entry) { map.delete(id); destroy(entry); } }, TTL);
  entry.timer.unref?.(); map.set(id, entry);
  const account = value.account;
  return { mfaRequired: true, challenge, expiresAt: new Date(expires).toISOString(), account,
    ...(value.enrollment ? { enrollment: { secret: base32Encode(value.seed),
      otpAuthUri: `otpauth://totp/${encodeURIComponent(`Zelos:${account.email}`)}?secret=${base32Encode(value.seed)}&issuer=Zelos&algorithm=SHA1&digits=6&period=30` } } : {}) };
}

/** Password proof was already checked by the account layer. No account changes and no browser session here. */
export async function beginFamilyMfa(db, { account, password, targetPassword = password, operation, validate }) {
  const before = factor(db, account.id), snapshot = familyAuthSnapshot(account);
  let key, seed;
  try {
    if (before) {
      const previousKey = await keyFor(password, before.salt, account.id);
      try { seed = unlock(before.sealed, previousKey, account.id); } finally { previousKey.fill(0); }
    } else seed = crypto.randomBytes(20);
    const salt = crypto.randomBytes(16).toString('hex');
    key = await keyFor(targetPassword, salt, account.id);
    validate();
    const currentAccount = db.prepare('SELECT * FROM family_accounts WHERE id=?').get(account.id);
    const current = factor(db, account.id);
    if (!currentAccount || familyAuthSnapshot(currentAccount) !== snapshot || (current?.version || null) !== (before?.version || null)) fail(401, 'This sign-in expired. Start again.');
    return issue(db, { accountId: account.id, account: { id: account.id, name: account.name, email: account.email, role: account.role, status: account.status },
      accountSnapshot: snapshot, expectedVersion: before?.version || null, seed, key, salt, operation, enrollment: !before });
  } catch (error) { destroy({ key, seed }); throw error; }
}
function consumeAttempt(db, accountId) {
  const now = Date.now(), previous = db.prepare('SELECT * FROM family_mfa_limits WHERE account_id=?').get(accountId);
  if (previous?.blocked_until > now) fail(429, 'Too many authentication attempts. Try again in 15 minutes.');
  const fresh = !previous || now - previous.window_start >= TTL;
  const attempts = fresh ? 1 : previous.attempts + 1, blocked = attempts > 10 ? now + 15 * 60000 : 0;
  db.prepare('INSERT INTO family_mfa_limits VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts,blocked_until=excluded.blocked_until')
    .run(accountId, fresh ? now : previous.window_start, attempts, blocked);
  if (blocked) fail(429, 'Too many authentication attempts. Try again in 15 minutes.');
}
function recoveryHashes(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.length <= 10 && parsed.every(code => /^[a-f0-9]{64}$/.test(code)) ? parsed : []; }
  catch { return []; }
}
function savepoint(db, operation) {
  db.exec('SAVEPOINT family_mfa_complete');
  try { const result = operation(); db.exec('RELEASE family_mfa_complete'); return result; }
  catch (error) { db.exec('ROLLBACK TO family_mfa_complete; RELEASE family_mfa_complete'); throw error; }
}
/** Completes one challenge atomically, or starts replacement enrollment after one-use factor recovery. */
export function verifyFamilyMfa(db, input, { validate, finish }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['challenge', 'code'].includes(key))) fail(400, 'Enter the authenticator code.');
  if (typeof input.challenge !== 'string' || !/^zfc_[A-Za-z0-9_-]{43}$/.test(input.challenge)) fail(401, 'This sign-in expired. Start again.');
  cleanup(db); const map = mapFor(db), challengeId = sha(input.challenge), value = map.get(challengeId);
  if (!value) fail(401, 'This sign-in expired. Start again.');
  const discard = () => { map.delete(challengeId); destroy(value); };
  const revalidate = () => {
    validate(value.operation);
    const account = db.prepare('SELECT * FROM family_accounts WHERE id=?').get(value.accountId), saved = factor(db, value.accountId);
    if (!account || familyAuthSnapshot(account) !== value.accountSnapshot || (saved?.version || null) !== value.expectedVersion) fail(401, 'This sign-in expired. Start again.');
    return saved;
  };
  try { consumeAttempt(db, value.accountId); }
  catch (error) { discard(); throw error; }
  value.attempts++;
  if (value.attempts > 5) { discard(); fail(429, 'Too many codes tried. This sign-in expired. Start again.'); }
  let current;
  try {
    current = revalidate();
  } catch (error) { discard(); throw error; }
  const code = typeof input.code === 'string' && input.code.length <= 100 ? input.code.trim() : '';
  const hashes = recoveryHashes(current?.recovery_json), recovered = !value.enrollment && /^zfr_[A-Za-z0-9_-]{22}$/.test(code)
    ? hashes.findIndex(digest => equal(digest, sha(code))) : -1;
  if (recovered >= 0) {
    const version = crypto.randomUUID(), seed = crypto.randomBytes(20), key = Buffer.from(value.key);
    const replacement = { ...value, seed, key, enrollment: true, expectedVersion: version, recovery: true };
    try {
      const result = savepoint(db, () => {
        revalidate();
        db.prepare('UPDATE family_mfa SET recovery_json=?,version=?,updated_at=? WHERE account_id=? AND version=?')
          .run(JSON.stringify(hashes.filter((_, index) => index !== recovered)), version, nowISO(), value.accountId, value.expectedVersion);
        db.prepare("UPDATE family_credentials SET revoked_at=? WHERE account_id=? AND kind='session' AND revoked_at IS NULL").run(nowISO(), value.accountId);
        return issue(db, replacement);
      });
      discard(); return result;
    } catch (error) { destroy(replacement); throw error; }
  }
  const counter = matchingCounter(value.seed, code, value.enrollment ? -1 : current.last_counter);
  if (counter === null) {
    if (value.attempts === 5) { discard(); fail(429, 'Too many codes tried. This sign-in expired. Start again.'); }
    fail(401, 'The code is incorrect or was already used.');
  }
  const recoveryCodes = value.enrollment || !hashes.length ? Array.from({ length: 8 }, () => `zfr_${crypto.randomBytes(16).toString('base64url')}`) : null;
  const result = savepoint(db, () => {
    revalidate();
    const sealed = seal(value.seed, value.key, value.accountId), version = crypto.randomUUID();
    const recoveryJson = recoveryCodes ? JSON.stringify(recoveryCodes.map(sha)) : current.recovery_json;
    db.prepare('INSERT INTO family_mfa VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET salt=excluded.salt,sealed=excluded.sealed,recovery_json=excluded.recovery_json,last_counter=excluded.last_counter,version=excluded.version,updated_at=excluded.updated_at')
      .run(value.accountId, value.salt, sealed, recoveryJson, counter, version, nowISO());
    if (value.recovery || value.operation.kind === 'invite') db.prepare("UPDATE family_credentials SET revoked_at=? WHERE account_id=? AND kind='session' AND revoked_at IS NULL").run(nowISO(), value.accountId);
    const response = finish(value.operation);
    return { ...response, ...(recoveryCodes ? { recoveryCodes } : {}) };
  });
  discard(); return result;
}
