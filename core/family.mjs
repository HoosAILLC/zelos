/** Family accounts and explicitly shared records. Owner workspace data never enters this module. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { migrateFamilyMfa, hasFamilyMfa, beginFamilyMfa, verifyFamilyMfa, FamilyMfaError } from './family-mfa.mjs';

const scrypt = promisify(crypto.scrypt);
const DAY = 86400000, MAX_BYTES = 8 * 1024 * 1024;
const KINDS = ['task', 'plan', 'event', 'tracking', 'note', 'document'];
const PERMISSIONS = ['view', 'submitTasks', 'uploadDocuments', 'directTasks'];
const AUTH = new WeakMap();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const stamp = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tokenValue = prefix => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const decode = row => row ? JSON.parse(row.data_json) : null;
const unexpired = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();

export class FamilyError extends Error {
  constructor(status, message) { super(message); this.name = 'FamilyError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new FamilyError(status, message); };
function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !keys.includes(key))) fail('This request has unsupported fields.');
  return input;
}
function text(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
      || (required && !value.trim())) fail(`Enter a valid ${label}.`);
  return value.trim();
}
const idText = value => text(value, 'identifier', 100);
function date(value = '', label = 'date') {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`Use YYYY-MM-DD for the ${label}.`);
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`Enter a real ${label}.`);
  return value;
}
function email(value) {
  const result = text(value, 'email address', 254).toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result)) fail('Enter a valid email address.');
  return result;
}
function expiry(value, defaultDays, cap = null) {
  const now = Date.now(), expires = value === undefined ? Math.min(now + defaultDays * DAY, cap || Infinity) : Date.parse(value);
  if ((value !== undefined && typeof value !== 'string') || !Number.isFinite(expires)
      || expires <= now || expires > now + 365 * DAY + 1000 || (cap && expires > cap)) fail('Choose an expiry in the next 365 days, no later than the access grant.');
  return new Date(expires).toISOString();
}
function strings(value, label, max) {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v || v.length > 100)
      || new Set(value).size !== value.length) fail(`Choose valid ${label}.`);
  return [...value];
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function transaction(db, operation) {
  db.exec('SAVEPOINT family_write');
  try { const result = operation(); db.exec('RELEASE family_write'); return result; }
  catch (error) { db.exec('ROLLBACK TO family_write; RELEASE family_write'); throw error; }
}
function get(db, table, id) { return decode(db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id)); }
function rows(db, table) { return db.prepare(`SELECT data_json FROM ${table} ORDER BY rowid DESC`).all().map(decode); }
function put(db, table, value) {
  db.prepare(`INSERT INTO ${table}(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`).run(value.id, JSON.stringify(value));
  return value;
}
function quota(db, table, limit, label) {
  if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n >= limit) fail(`The ${label} limit has been reached. Remove an unused entry first.`, 409);
}

export function migrateFamily(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_workspace (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS family_accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','parent','collaborator')),
      status TEXT NOT NULL CHECK(status IN ('invited','active','revoked')), password_hash TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_invitations (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES family_accounts(id), token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS family_credentials (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES family_accounts(id), grant_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('session','api')), label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS family_credentials_account ON family_credentials(account_id);
    CREATE TABLE IF NOT EXISTS family_children (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS family_records (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS family_grants (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS family_submissions (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS family_files (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      digest TEXT NOT NULL, bytes BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_requests (
      account_id TEXT NOT NULL, grant_id TEXT NOT NULL, action TEXT NOT NULL, request_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(account_id,grant_id,action,request_key)
    );
    CREATE TABLE IF NOT EXISTS family_activity (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, recipient_id TEXT NOT NULL, action TEXT NOT NULL,
      target_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const now = stamp();
  db.prepare("INSERT OR IGNORE INTO family_accounts VALUES('owner','','You','owner','active',NULL,'owner',?,?)").run(now, now);
  db.prepare('INSERT OR IGNORE INTO family_workspace VALUES(?,?)').run('family', JSON.stringify({ id: 'family', name: 'Your family' }));
  migrateFamilyMfa(db);
}

function accountRow(db, id) { return db.prepare('SELECT * FROM family_accounts WHERE id=?').get(id); }
function accountView(row, includeEmail = true) {
  return { id: row.id, name: row.name, ...(includeEmail ? { email: row.email } : {}), role: row.role, status: row.status };
}
function parent(account) { return account && ['owner', 'parent'].includes(account.role) && account.status === 'active'; }
function requireParent(actor) {
  if (!parent(actor.account) || actor.credential?.kind === 'api') fail('This action needs a parent account.', 403);
}
function audit(db, actorId, action, targetId, recipientId = actorId) {
  db.prepare('INSERT INTO family_activity VALUES(?,?,?,?,?,?)').run(uid(), actorId, recipientId, action, targetId, stamp());
  db.exec('DELETE FROM family_activity WHERE rowid NOT IN (SELECT rowid FROM family_activity ORDER BY rowid DESC LIMIT 10000)');
}
function grantActive(db, value) {
  if (!value || value.status !== 'active' || !unexpired(value.expiresAt)) return false;
  // An owner-issued API credential is independently sufficient; browser sessions still require invitation acceptance.
  return parent(accountRow(db, value.grantorId)) && ['active', 'invited'].includes(accountRow(db, value.accountId)?.status);
}
function credentialRow(db, id) { return db.prepare('SELECT * FROM family_credentials WHERE id=?').get(id); }
function validateCredential(db, credential) {
  const account = credential && accountRow(db, credential.account_id);
  if (!credential || credential.revoked_at || !unexpired(credential.expires_at)
      || !account || !(account.status === 'active' || account.status === 'invited' && credential.kind === 'api')
      || account.role === 'owner') fail('Sign in again to continue.', 401);
  if (credential.kind === 'session' && !hasFamilyMfa(db, account.id)) fail('Sign in again and set up your authenticator.', 401);
  let grant = null;
  if (credential.kind === 'api') {
    grant = get(db, 'family_grants', credential.grant_id);
    if (!grantActive(db, grant) || grant.accountId !== account.id) fail('This access has expired or was revoked.', 401);
  }
  return { account, credential, grant };
}
function actorContext(db, actor) {
  if (actor && actor.accountId === 'owner' && Object.keys(actor).length === 1) {
    const account = accountRow(db, 'owner');
    if (!parent(account)) fail('The local owner is unavailable.', 401);
    return { account, credential: null, grant: null };
  }
  const proof = actor && AUTH.get(actor);
  if (!proof) fail('Sign in again to continue.', 401);
  const credential = credentialRow(db, proof.id);
  if (!credential || credential.token_hash !== proof.hash) fail('Sign in again to continue.', 401);
  return validateCredential(db, credential);
}
export function authenticateFamily(db, token) {
  if (typeof token !== 'string' || !/^zf[sa]_[A-Za-z0-9_-]{43}$/.test(token)) fail('Sign in again to continue.', 401);
  const credential = db.prepare('SELECT * FROM family_credentials WHERE token_hash=?').get(hash(token));
  const context = validateCredential(db, credential);
  const actor = Object.freeze({ accountId: context.account.id, credentialId: credential.id,
    ...(context.grant ? { grantId: context.grant.id } : {}) });
  AUTH.set(actor, { id: credential.id, hash: credential.token_hash });
  return actor;
}
function mintCredential(db, { accountId, grantId = null, kind, label, creatorId, expiresAt }) {
  if (db.prepare('SELECT count(*) AS n FROM family_credentials WHERE revoked_at IS NULL AND expires_at>?').get(stamp()).n >= 200) fail('The active credential limit has been reached. Revoke an unused credential first.', 409);
  db.prepare('DELETE FROM family_credentials WHERE (revoked_at IS NOT NULL OR expires_at<=?) AND rowid NOT IN (SELECT rowid FROM family_credentials ORDER BY rowid DESC LIMIT 1000)').run(stamp());
  const token = tokenValue(kind === 'session' ? 'zfs' : 'zfa'), id = uid(), now = stamp();
  db.prepare('INSERT INTO family_credentials VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id, accountId, grantId, kind, label, hash(token), creatorId, now, expiresAt);
  return { token, credential: { id, label, accountId, grantId, kind, createdAt: now, expiresAt, revokedAt: null } };
}
function session(db, account) {
  const live = db.prepare("SELECT id FROM family_credentials WHERE account_id=? AND kind='session' AND revoked_at IS NULL ORDER BY created_at DESC").all(account.id);
  for (const row of live.slice(19)) db.prepare('UPDATE family_credentials SET revoked_at=? WHERE id=?').run(stamp(), row.id);
  const result = mintCredential(db, { accountId: account.id, kind: 'session', label: 'Browser session', creatorId: account.id, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString() });
  return { token: result.token, account: accountView(account) };
}
function passwordInput(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || value.includes('\0')) fail('Use a password with 12–128 characters.');
  return value;
}
async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex'), legacy = false) {
  const result = await scrypt(password, salt, 32, { N: legacy ? 16384 : 32768, r: 8, p: legacy ? 1 : 3, maxmem: 64 * 1024 * 1024 });
  return `${legacy ? 'scrypt' : 'scrypt2'}$${salt}$${result.toString('hex')}`;
}
const DUMMY_PASSWORD = `scrypt2$${'0'.repeat(32)}$${'0'.repeat(64)}`;
function missingRecoveryPassword(db, account) {
  return !account.password_hash && (!!db.prepare('SELECT 1 FROM family_invitations WHERE account_id=? AND used_at IS NOT NULL LIMIT 1').get(account.id)
    || !!db.prepare("SELECT 1 FROM family_records WHERE json_extract(data_json,'$.ownerId')=? LIMIT 1").get(account.id));
}
async function passwordMatches(password, encoded) {
  const expected = typeof encoded === 'string' && /^scrypt2?\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(encoded) ? encoded : DUMMY_PASSWORD;
  const candidate = await passwordHash(typeof password === 'string' && password.length <= 128 ? password : '', expected.split('$')[1], expected.startsWith('scrypt$'));
  return crypto.timingSafeEqual(Buffer.from(hash(candidate), 'hex'), Buffer.from(hash(expected), 'hex')) && expected !== DUMMY_PASSWORD;
}
export async function acceptFamilyInvite(db, input) {
  object(input, ['token', 'password', 'currentPassword']);
  passwordInput(input.password);
  if (typeof input.token !== 'string' || !/^zfi_[A-Za-z0-9_-]{43}$/.test(input.token)) fail('This invitation is unavailable or expired.', 401);
  const tokenHash = hash(input.token);
  const invitation = db.prepare('SELECT * FROM family_invitations WHERE token_hash=?').get(tokenHash);
  const available = row => row && !row.used_at && !row.revoked_at && Date.parse(row.expires_at) > Date.now()
    && parent(accountRow(db, row.created_by)) && accountRow(db, row.account_id)?.status === 'invited';
  if (!available(invitation)) fail('This invitation is unavailable or expired.', 401);
  const previousAccount = accountRow(db, invitation.account_id);
  if (missingRecoveryPassword(db, previousAccount)) fail('This existing account is missing its password verifier. Restore a complete backup before reconnecting it.', 409);
  const previousPassword = previousAccount.password_hash;
  if (previousPassword && !await passwordMatches(input.currentPassword, previousPassword)) fail('Reactivating this account also requires its current password. The invitation cannot reset someone else’s password.', 401);
  const encoded = await passwordHash(input.password);
  const operation = { kind: 'invite', accountId: previousAccount.id, expectedPasswordHash: previousPassword,
    invitationId: invitation.id, invitationHash: tokenHash, newPasswordHash: encoded };
  validateMfaOperation(db, operation);
  try { return await beginFamilyMfa(db, { account: previousAccount, password: previousPassword ? input.currentPassword : input.password,
    targetPassword: input.password, operation, validate: () => validateMfaOperation(db, operation) }); }
  catch (error) { if (error instanceof FamilyMfaError) throw new FamilyError(error.status, error.message); throw error; }
}
export async function loginFamily(db, input) {
  object(input, ['email', 'password']);
  let address = ''; try { address = email(input.email); } catch { /* same password work and response */ }
  const before = address ? db.prepare('SELECT * FROM family_accounts WHERE email=?').get(address) : null;
  const matched = await passwordMatches(input.password, before?.password_hash);
  const current = before && accountRow(db, before.id);
  if (!matched || !current || current.status !== 'active' || current.role === 'owner'
      || current.password_hash !== before.password_hash) fail('The email or password is incorrect.', 401);
  if (!hasFamilyMfa(db, current.id)) fail('Use a fresh family invitation to set up your authenticator.', 401);
  const operation = { kind: 'login', accountId: current.id, expectedPasswordHash: current.password_hash,
    ...(current.password_hash.startsWith('scrypt$') ? { newPasswordHash: await passwordHash(input.password) } : {}) };
  validateMfaOperation(db, operation);
  try { return await beginFamilyMfa(db, { account: current, password: input.password, operation, validate: () => validateMfaOperation(db, operation) }); }
  catch (error) { if (error instanceof FamilyMfaError) throw new FamilyError(error.status, error.message); throw error; }
}
function validateMfaOperation(db, operation) {
  const account = accountRow(db, operation.accountId);
  if (!account || account.role === 'owner' || account.password_hash !== operation.expectedPasswordHash) fail('This sign-in expired. Start again.', 401);
  if (operation.kind === 'login') {
    if (account.status !== 'active') fail('This sign-in expired. Start again.', 401);
  } else if (operation.kind === 'invite') {
    const invitation = db.prepare('SELECT * FROM family_invitations WHERE id=?').get(operation.invitationId);
    if (account.status !== 'invited' || !invitation || invitation.account_id !== account.id || invitation.token_hash !== operation.invitationHash
        || invitation.used_at || invitation.revoked_at || !unexpired(invitation.expires_at)
        || !parent(accountRow(db, invitation.created_by))) fail('This sign-in expired. Start again.', 401);
  } else fail('This sign-in expired. Start again.', 401);
}
export async function completeFamilyMfa(db, input) {
  try {
    return verifyFamilyMfa(db, input, { validate: operation => validateMfaOperation(db, operation), finish: operation => {
      const account = accountRow(db, operation.accountId), now = stamp();
      if (operation.kind === 'invite') {
        db.prepare("UPDATE family_accounts SET password_hash=?,status='active',updated_at=? WHERE id=?").run(operation.newPasswordHash, now, account.id);
        db.prepare('UPDATE family_invitations SET used_at=? WHERE id=?').run(now, operation.invitationId);
        db.prepare('UPDATE family_invitations SET revoked_at=? WHERE account_id=? AND id<>? AND used_at IS NULL').run(now, account.id, operation.invitationId);
        audit(db, account.id, 'member.accept', account.id, account.created_by);
      } else {
        if (operation.newPasswordHash) db.prepare('UPDATE family_accounts SET password_hash=?,updated_at=? WHERE id=?').run(operation.newPasswordHash, now, account.id);
        audit(db, account.id, 'account.login', account.id);
      }
      return session(db, accountRow(db, account.id));
    } });
  } catch (error) { if (error instanceof FamilyMfaError) throw new FamilyError(error.status, error.message); throw error; }
}
export function logoutFamily(db, token) {
  const actor = authenticateFamily(db, token), context = actorContext(db, actor);
  if (context.credential.kind !== 'session') fail('This credential is not a browser session.', 403);
  db.prepare('UPDATE family_credentials SET revoked_at=? WHERE id=?').run(stamp(), context.credential.id);
  return { ok: true };
}

function guardian(db, account, childId) {
  const child = childId && get(db, 'family_children', childId);
  return !!child && parent(account) && child.guardianIds.includes(account.id);
}
function canReadRecord(db, account, record) {
  if (!parent(account) || !record || (record.subjectId && !guardian(db, account, record.subjectId))) return false;
  return record.ownerId === account.id || record.visibility === 'family';
}
function canManageRecord(db, account, record) {
  return canReadRecord(db, account, record) && (record.ownerId === account.id || record.visibility === 'family');
}
function subjectAllowed(db, grant, subjectId) {
  const grantor = accountRow(db, grant.grantorId);
  return subjectId ? grant.subjectIds.includes(subjectId) && guardian(db, grantor, subjectId) : grant.subjectIds.includes('self');
}
function grantCanRead(db, grant, record) {
  if (!grantActive(db, grant) || !grant.permissions.view || !canReadRecord(db, accountRow(db, grant.grantorId), record)) return false;
  if (grant.recordIds.includes(record.id)) {
    const binding = grant.recordBindings?.[record.id];
    return !!binding && binding.ownerId === record.ownerId && binding.subjectId === record.subjectId && binding.kind === record.kind;
  }
  return grant.includeFuture && grant.kinds.includes(record.kind) && (record.subjectId
    ? subjectAllowed(db, grant, record.subjectId)
    : record.ownerId === grant.grantorId && grant.subjectIds.includes('self'));
}
function actorGrants(db, context) {
  if (context.grantCache) return context.grantCache;
  if (context.grant) return grantActive(db, context.grant) ? [context.grant] : [];
  return rows(db, 'family_grants').filter(grant => grant.accountId === context.account.id && grantActive(db, grant));
}
function readForContext(db, context, record) {
  return parent(context.account) && !context.grant ? canReadRecord(db, context.account, record)
    : actorGrants(db, context).some(grant => grantCanRead(db, grant, record));
}
function submissionReadable(db, context, submission) {
  if (parent(context.account) && !context.grant) return submission.recipientId === context.account.id
    && (!submission.subjectId || guardian(db, context.account, submission.subjectId));
  return submission.createdBy === context.account.id && actorGrants(db, context).some(grant => grant.id === submission.grantId
    && subjectAllowed(db, grant, submission.subjectId) && grant.permissions[submission.kind === 'task' ? 'submitTasks' : 'uploadDocuments']);
}
function grantView(db, grant, collaborator = false) {
  if (!collaborator) return { ...grant };
  return { id: grant.id, label: grant.label, accountId: grant.accountId, grantorId: grant.grantorId,
    grantorName: accountRow(db, grant.grantorId)?.name || '', status: grant.status,
    permissions: { ...grant.permissions }, expiresAt: grant.expiresAt, includeFuture: grant.includeFuture,
    recordIds: grant.permissions.view ? grant.recordIds.filter(id => grantCanRead(db, grant, get(db, 'family_records', id))) : [],
    subjectIds: grant.subjectIds.filter(id => id === 'self' || guardian(db, accountRow(db, grant.grantorId), id)), kinds: [...grant.kinds] };
}
function stateFor(db, context) {
  const administrator = parent(context.account) && !context.grant;
  if (!administrator) context = { ...context, grantCache: actorGrants(db, context) };
  const availableGrants = administrator ? rows(db, 'family_grants').filter(g => g.grantorId === context.account.id) : actorGrants(db, context);
  const allowedRecords = rows(db, 'family_records').filter(record => readForContext(db, context, record));
  const visibleRecords = allowedRecords.slice(0, 500);
  const children = rows(db, 'family_children').filter(child => administrator ? guardian(db, context.account, child.id)
    : availableGrants.some(grant => grant.subjectIds.includes(child.id) && guardian(db, accountRow(db, grant.grantorId), child.id))
      || visibleRecords.some(record => record.subjectId === child.id));
  const accounts = db.prepare('SELECT * FROM family_accounts ORDER BY created_at').all();
  const members = accounts.filter(account => administrator
    ? account.id === context.account.id || account.role !== 'collaborator' || account.created_by === context.account.id
    : account.id === context.account.id || availableGrants.some(grant => grant.grantorId === account.id))
    .map(account => accountView(account, administrator));
  const invitations = administrator ? db.prepare('SELECT * FROM family_invitations WHERE created_by=? ORDER BY created_at DESC LIMIT 100').all(context.account.id)
    .map(row => { const member = accountRow(db, row.account_id); return { id: row.id, accountId: row.account_id, name: member.name,
      email: member.email, role: member.role, recoveryRequired: !!member.password_hash, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at, revokedAt: row.revoked_at }; }) : [];
  const credentials = administrator ? db.prepare("SELECT * FROM family_credentials WHERE created_by=? AND kind='api' ORDER BY created_at DESC LIMIT 100").all(context.account.id)
    .map(row => ({ id: row.id, accountId: row.account_id, grantId: row.grant_id, label: row.label,
      kind: row.kind, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at })) : [];
  const submissions = rows(db, 'family_submissions').filter(value => submissionReadable(db, context, value)).slice(0, 200).map(({ reviewHash, ...value }) => value);
  const activity = context.grant ? [] : db.prepare('SELECT * FROM family_activity WHERE actor_id=? OR recipient_id=? ORDER BY rowid DESC LIMIT 100').all(context.account.id, context.account.id)
    .map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, targetId: row.target_id, createdAt: row.created_at }));
  return { family: get(db, 'family_workspace', 'family'), me: accountView(context.account), members,
    children: administrator ? children : children.map(child => ({ id: child.id, name: child.name })),
    records: visibleRecords, grants: availableGrants.slice(0, 200).map(grant => grantView(db, grant, !administrator)),
    submissions, invitations, credentials, activity,
    permissions: { manageFamily: administrator, manageAccess: administrator, createRecords: administrator },
    pagination: { records: { limit: 500, hasMore: allowedRecords.length > 500 } } };
}
function auditRead(db, context, records = null) {
  if (parent(context.account) && !context.grant) return;
  for (const grant of actorGrants(db, context)) if (!records || records.some(record => grantCanRead(db, grant, record))) {
    audit(db, context.account.id, 'access.view', grant.id, grant.grantorId);
  }
}
export function familyState(db, actor) {
  const context = actorContext(db, actor), result = stateFor(db, context);
  auditRead(db, context);
  return result;
}
/** Versioned API list. Permissions precede filtering, counts, and pagination. */
export function familyRecords(db, actor, options = {}) {
  object(options, ['limit', 'offset', 'kind', 'subjectId', 'status', 'visibility']);
  const limit = options.limit ?? 100, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) fail('Choose a limit of 1–200 and an offset of 0–5000.');
  if (options.kind !== undefined && !KINDS.includes(options.kind)
      || options.status !== undefined && !['open', 'done'].includes(options.status)
      || options.visibility !== undefined && !['private', 'family'].includes(options.visibility)
      || options.subjectId !== undefined && (typeof options.subjectId !== 'string' || options.subjectId.length > 100)) fail('Choose supported record filters.');
  const context = actorContext(db, actor);
  if (!parent(context.account) || context.grant) context.grantCache = actorGrants(db, context);
  const allowed = rows(db, 'family_records').filter(record => readForContext(db, context, record))
    .filter(record => ['kind', 'subjectId', 'status', 'visibility'].every(key => options[key] === undefined || record[key] === options[key]));
  const records = allowed.slice(offset, offset + limit);
  auditRead(db, context, records);
  return { records, total: allowed.length, offset, limit, hasMore: offset + records.length < allowed.length };
}
export function familyRecord(db, actor, recordId) {
  const context = actorContext(db, actor), record = get(db, 'family_records', idText(recordId));
  if (!readForContext(db, context, record)) fail('This record is unavailable.', 404);
  auditRead(db, context, [record]);
  return record;
}
export function familySubmission(db, actor, submissionId) {
  const context = actorContext(db, actor), submission = get(db, 'family_submissions', idText(submissionId));
  if (!submission || !submissionReadable(db, context, submission)) fail('This submission is unavailable.', 404);
  if (!parent(context.account) || context.grant) audit(db, context.account.id, 'access.view', submission.grantId, submission.recipientId);
  const { reviewHash, ...view } = submission;
  return view;
}

function allowedSubject(db, account, subjectId) {
  if (typeof subjectId !== 'string' || subjectId.length > 100 || subjectId && !guardian(db, account, subjectId)) fail('Choose a child you currently manage.', 403);
  return subjectId;
}
function recordValue(db, account, input, previous = null, { document = false, createdBy = account.id } = {}) {
  const kind = input.kind ?? previous?.kind;
  if (!KINDS.includes(kind) || kind === 'document' && !document && !previous) fail('Choose a supported record type. Upload documents separately.');
  if (previous && kind !== previous.kind) fail('A record cannot change type.');
  const subjectId = allowedSubject(db, account, input.subjectId ?? previous?.subjectId ?? '');
  const assigneeId = input.assigneeId ?? previous?.assigneeId ?? (kind === 'task' ? account.id : '');
  if (typeof assigneeId !== 'string' || assigneeId && (!parent(accountRow(db, assigneeId))
      || subjectId && !guardian(db, accountRow(db, assigneeId), subjectId))) fail('Choose an active parent who manages this person.');
  const visibility = input.visibility ?? previous?.visibility ?? 'private', status = input.status ?? previous?.status ?? 'open';
  if (!['private', 'family'].includes(visibility) || !['open', 'done'].includes(status)) fail('Choose a supported visibility and status.');
  if (kind === 'task' && visibility === 'private' && assigneeId && assigneeId !== (previous?.ownerId || account.id)) fail('Share this task with family before assigning another parent.');
  if (previous && previous.ownerId !== account.id && (subjectId !== previous.subjectId || visibility !== previous.visibility)) fail('Only the owner can change a record’s person or visibility.', 403);
  const now = stamp();
  return { ...(previous || {}), id: previous?.id || uid(), kind, title: text(input.title ?? previous?.title, 'title', 200),
    details: text(input.details ?? previous?.details ?? '', 'details', 20000, false), date: date(input.date ?? previous?.date ?? ''),
    subjectId, assigneeId, visibility, status, ownerId: previous?.ownerId || account.id, createdBy: previous?.createdBy || createdBy,
    createdAt: previous?.createdAt || now, updatedAt: now, version: (previous?.version || 0) + 1,
    source: text(input.source ?? previous?.source ?? '', 'snapshot label', 500, false) };
}
function version(input, previous) {
  if (!Number.isSafeInteger(input.version) || input.version !== previous.version) fail('This record changed. Reload it before saving or deleting.', 409);
}
function saveRecord(db, account, input, options) {
  const previous = input.id ? get(db, 'family_records', idText(input.id)) : null;
  if (input.id && !canManageRecord(db, account, previous)) fail('This record is unavailable.', 404);
  if (previous) version(input, previous); else quota(db, 'family_records', 5000, 'family records');
  return put(db, 'family_records', recordValue(db, account, input, previous, options));
}
function fileInput(input) {
  if (typeof input.base64 !== 'string' || !input.base64 || input.base64.length > Math.ceil(MAX_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) fail('Choose a PDF, PNG, JPEG, or text document up to 8 MiB.');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== input.base64) fail('The document encoding is invalid.');
  let filename = text(input.filename, 'filename', 255).split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').slice(0, 160) || 'document';
  let mime, extension;
  if (bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) { mime = 'application/pdf'; extension = 'pdf'; }
  else if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12,16).toString() === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 20000 || height > 20000 || width * height > 25000000) fail('Resize this image to at most 25 million pixels.');
    mime = 'image/png'; extension = 'png';
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) { mime = 'image/jpeg'; extension = 'jpg'; }
  else if (/\.txt$/i.test(filename)) {
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Text documents must contain UTF-8 text.'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail('This file contains binary data. Choose a text document.');
    mime = 'text/plain; charset=utf-8'; extension = 'txt';
  } else fail('The file content is not a supported PDF, PNG, JPEG, or UTF-8 text document.');
  if (!(extension === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${extension}$`, 'i')).test(filename)) filename = `${filename.slice(0, 150)}.${extension}`;
  return { filename, mime, bytes, size: bytes.length, digest: hash(bytes) };
}
function storeFile(db, id, file) {
  const total = db.prepare('SELECT coalesce(sum(size),0) AS bytes,count(*) AS n FROM family_files').get();
  if (total.bytes + file.size > 128 * 1024 * 1024 || total.n >= 128) fail('The shared document storage limit has been reached. Remove an unused document first.', 409);
  db.prepare('INSERT INTO family_files VALUES(?,?,?,?,?,?)').run(id, file.filename, file.mime, file.size, file.digest, file.bytes);
}
function requestReplay(db, context, action, input, grantId, perform) {
  const key = text(input.idempotencyKey, 'request key', 100);
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) fail('Use a unique request key with 8–100 letters, numbers, dots, colons, or dashes.');
  const payloadHash = hash(JSON.stringify(stable(input)));
  const previous = db.prepare('SELECT * FROM family_requests WHERE account_id=? AND grant_id=? AND action=? AND request_key=?').get(context.account.id, grantId, action, key);
  if (previous) {
    if (previous.payload_hash !== payloadHash) fail('This request key was already used for different content.', 409);
    return { ...JSON.parse(previous.result_json), replayed: true };
  }
  quota(db, 'family_requests', 10000, 'saved submission receipts');
  const result = perform();
  db.prepare('INSERT INTO family_requests VALUES(?,?,?,?,?,?,?)').run(context.account.id, grantId, action, key, payloadHash, JSON.stringify(result), stamp());
  return result;
}
function submissionGrant(db, context, input, kind) {
  const permission = kind === 'task' ? 'submitTasks' : 'uploadDocuments';
  if (context.grant && input.grantId !== undefined && input.grantId !== context.grant.id) fail('This API token belongs to a different access grant.', 403);
  let grants = actorGrants(db, context).filter(grant => grant.permissions[permission] && grant.kinds.includes(kind));
  if (input.grantId !== undefined) grants = grants.filter(grant => grant.id === input.grantId);
  if (grants.length !== 1) fail(grants.length ? 'Choose the access grant for this submission.' : 'This access does not allow that submission.', 403);
  const grant = grants[0], subjectId = input.subjectId ?? '';
  if (typeof subjectId !== 'string' || !subjectAllowed(db, grant, subjectId)) fail('This person is outside your access grant.', 403);
  return grant;
}
function submit(db, context, input, kind, file = null) {
  const grant = submissionGrant(db, context, input, kind);
  const values = { kind, title: text(input.title ?? file?.filename, 'title', 200), details: text(input.details ?? '', 'details', 20000, false),
    date: date(input.date ?? ''), subjectId: input.subjectId ?? '', assigneeId: grant.grantorId, visibility: 'private' };
  return requestReplay(db, context, kind === 'task' ? 'task.submit' : 'document.upload', input, grant.id, () => {
    if (kind === 'task' && grant.permissions.directTasks) {
      const record = saveRecord(db, accountRow(db, grant.grantorId), values, { createdBy: context.account.id });
      audit(db, context.account.id, 'task.create', record.id, grant.grantorId);
      return { record, direct: true };
    }
    quota(db, 'family_submissions', 2000, 'submissions');
    const submission = { id: uid(), ...values, recipientId: grant.grantorId, createdBy: context.account.id,
      submittedBy: context.account.id, grantId: grant.id, status: 'pending', createdAt: stamp(), reviewedAt: null, recordId: null,
      ...(file ? { filename: file.filename, size: file.size, mime: file.mime } : {}) };
    if (file) storeFile(db, submission.id, file);
    put(db, 'family_submissions', submission);
    audit(db, context.account.id, `${kind}.submit`, submission.id, grant.grantorId);
    return { submission };
  });
}

export async function familyAction(db, actor, action, input = {}) {
  const context = actorContext(db, actor), account = context.account;
  if (typeof action !== 'string') fail('Choose a supported family action.');
  // Every mutation below is synchronous inside one transaction. Password work has its own revalidation above.
  return transaction(db, () => {
    actorContext(db, actor);
    if (action === 'account.update') {
      object(input, ['name']);
      if (context.grant) fail('An API token cannot change an account.', 403);
      db.prepare('UPDATE family_accounts SET name=?,updated_at=? WHERE id=?').run(text(input.name, 'name', 120), stamp(), account.id);
      audit(db, account.id, action, account.id);
      return { account: accountView(accountRow(db, account.id)) };
    }
    if (action === 'task.submit') {
      object(input, ['title', 'details', 'date', 'subjectId', 'idempotencyKey', 'grantId']);
      return submit(db, context, input, 'task');
    }
    if (action === 'document.upload') {
      object(input, ['filename', 'base64', 'title', 'details', 'subjectId', 'visibility', 'idempotencyKey', 'grantId']);
      if (!parent(account) || context.grant) {
        if (input.visibility !== undefined) fail('The recipient chooses document visibility.', 403);
        submissionGrant(db, context, input, 'document');
        return submit(db, context, input, 'document', fileInput(input));
      }
      if (input.grantId !== undefined) fail('Parent document uploads do not use an access grant.');
      allowedSubject(db, account, input.subjectId ?? '');
      const file = fileInput(input);
      return requestReplay(db, context, action, input, '', () => {
        const record = saveRecord(db, account, { kind: 'document', title: input.title || file.filename,
          details: input.details, subjectId: input.subjectId, visibility: input.visibility }, { document: true });
        Object.assign(record, { filename: file.filename, size: file.size, mime: file.mime });
        storeFile(db, record.id, file); put(db, 'family_records', record);
        audit(db, account.id, action, record.id);
        return { record };
      });
    }
    requireParent(context);
    if (action === 'family.update') {
      object(input, ['name']);
      const family = put(db, 'family_workspace', { id: 'family', name: text(input.name, 'family name', 120) });
      audit(db, account.id, action, 'family'); return { family };
    }
    if (action === 'member.invite') {
      object(input, ['name', 'email', 'role', 'expiresAt']);
      if (!['parent', 'collaborator'].includes(input.role) || input.role === 'parent' && account.role !== 'owner') fail('Only the owner can invite another parent.', 403);
      const address = email(input.email), name = text(input.name, 'name', 120), expiresAt = expiry(input.expiresAt, 7);
      let member = db.prepare('SELECT * FROM family_accounts WHERE email=?').get(address);
      if (member && (!['invited', 'revoked'].includes(member.status) || member.created_by !== account.id || member.role !== input.role)) fail('An invitation for this address is unavailable.', 409);
      if (member && missingRecoveryPassword(db, member)) fail('This existing account is missing its password verifier. Restore a complete backup before reconnecting it.', 409);
      const now = stamp();
      if (!member) {
        quota(db, 'family_accounts', 100, 'family accounts');
        const id = uid();
        db.prepare("INSERT INTO family_accounts VALUES(?,?,?,?,'invited',NULL,?,?,?)").run(id, address, name, input.role, account.id, now, now);
        member = accountRow(db, id);
      } else db.prepare("UPDATE family_accounts SET name=?,status='invited',updated_at=? WHERE id=?").run(name, now, member.id);
      quota(db, 'family_invitations', 2000, 'saved invitations');
      db.prepare('UPDATE family_invitations SET revoked_at=? WHERE account_id=? AND used_at IS NULL AND revoked_at IS NULL').run(now, member.id);
      const id = uid(), inviteToken = tokenValue('zfi');
      db.prepare('INSERT INTO family_invitations VALUES(?,?,?,?,?,?,NULL,NULL)').run(id, member.id, hash(inviteToken), account.id, now, expiresAt);
      audit(db, account.id, action, member.id);
      return { invitation: { id, accountId: member.id, name, email: address, role: input.role, recoveryRequired: !!member.password_hash, expiresAt, createdAt: now }, inviteToken };
    }
    if (action === 'member.revoke') {
      object(input, ['id']);
      const member = accountRow(db, idText(input.id));
      if (!member || member.id === 'owner' || member.id === account.id || !(member.role === 'parent' ? account.role === 'owner' : member.created_by === account.id)) fail('This account cannot be removed by you.', 403);
      if (member.role === 'parent' && rows(db, 'family_children').some(child => child.guardianIds.includes(member.id)
        && !child.guardianIds.some(id => id !== member.id && parent(accountRow(db, id))))) fail('Assign another guardian to their children before removing this parent.', 409);
      const now = stamp();
      const removed = new Set([member.id, ...db.prepare("SELECT id FROM family_accounts WHERE created_by=? AND role='collaborator'").all(member.id).map(row => row.id)]);
      for (const id of removed) {
        db.prepare("UPDATE family_accounts SET status='revoked',updated_at=? WHERE id=?").run(now, id);
        db.prepare('UPDATE family_invitations SET revoked_at=? WHERE account_id=? OR created_by=?').run(now, id, id);
        db.prepare('UPDATE family_credentials SET revoked_at=? WHERE account_id=? OR created_by=?').run(now, id, id);
      }
      for (const grant of rows(db, 'family_grants')) if (removed.has(grant.accountId) || removed.has(grant.grantorId)) {
        put(db, 'family_grants', { ...grant, status: 'revoked', revokedAt: now });
        db.prepare('UPDATE family_credentials SET revoked_at=? WHERE grant_id=?').run(now, grant.id);
      }
      audit(db, account.id, action, member.id); return { ok: true };
    }
    if (action === 'child.save') {
      object(input, ['id', 'name', 'birthday', 'notes', 'guardianIds']);
      const previous = input.id ? get(db, 'family_children', idText(input.id)) : null;
      if (input.id && (!previous || !guardian(db, account, previous.id))) fail('This child profile is unavailable.', 404);
      const guardians = strings(input.guardianIds, 'guardians', 20);
      if (!guardians.length || !guardians.includes(account.id) || guardians.some(id => !parent(accountRow(db, id)))) fail('Include yourself and choose active parent accounts as guardians.');
      if (!previous) quota(db, 'family_children', 50, 'child profiles');
      const child = put(db, 'family_children', { id: previous?.id || uid(), name: text(input.name, 'child name', 120), birthday: date(input.birthday ?? previous?.birthday ?? '', 'birthday'),
        notes: text(input.notes ?? previous?.notes ?? '', 'notes', 4000, false), guardianIds: guardians,
        createdAt: previous?.createdAt || stamp(), updatedAt: stamp() });
      audit(db, account.id, action, child.id); return { child };
    }
    if (action === 'record.save') {
      object(input, ['id', 'kind', 'title', 'details', 'date', 'subjectId', 'assigneeId', 'visibility', 'status', 'version', 'source']);
      const record = saveRecord(db, account, input); audit(db, account.id, action, record.id, record.ownerId); return { record };
    }
    if (action === 'record.delete') {
      object(input, ['id', 'version']);
      const record = get(db, 'family_records', idText(input.id));
      if (!canManageRecord(db, account, record)) fail('This record is unavailable.', 404);
      version(input, record);
      db.prepare('DELETE FROM family_records WHERE id=?').run(record.id); db.prepare('DELETE FROM family_files WHERE id=?').run(record.id);
      audit(db, account.id, action, record.id, record.ownerId); return { ok: true };
    }
    if (action === 'grant.create') {
      object(input, ['accountId', 'label', 'recordIds', 'subjectIds', 'kinds', 'includeFuture', 'permissions', 'expiresAt']);
      const recipient = accountRow(db, idText(input.accountId));
      if (!recipient || recipient.role !== 'collaborator' || !['active', 'invited'].includes(recipient.status) || recipient.created_by !== account.id) fail('Choose a collaborator you invited.', 403);
      const recordIds = strings(input.recordIds ?? [], 'records', 200), subjectIds = strings(input.subjectIds ?? [], 'people', 50), kinds = strings(input.kinds ?? [], 'record types', 6);
      if (recordIds.some(id => !canReadRecord(db, account, get(db, 'family_records', id)))) fail('One of the selected records is unavailable.', 403);
      if (subjectIds.some(id => id !== 'self' && !guardian(db, account, id)) || kinds.some(kind => !KINDS.includes(kind))) fail('Choose supported people and record types.');
      object(input.permissions, PERMISSIONS);
      if (Object.values(input.permissions).some(value => typeof value !== 'boolean')) fail('Access permissions must be true or false.');
      const permissions = Object.fromEntries(PERMISSIONS.map(key => [key, input.permissions[key] === true]));
      const includeFuture = input.includeFuture ?? false;
      if (typeof includeFuture !== 'boolean' || !Object.values(permissions).some(Boolean)
          || permissions.directTasks && !permissions.submitTasks) fail('Choose valid access permissions.');
      if (includeFuture && (!permissions.view || !subjectIds.length || !kinds.length)) fail('Future records need explicit people, record types, and view permission.');
      if (permissions.view && !recordIds.length && !includeFuture) fail('Choose records to share, or explicitly include future records.');
      if (permissions.submitTasks && (!subjectIds.length || !kinds.includes('task'))
          || permissions.uploadDocuments && (!subjectIds.length || !kinds.includes('document'))) fail('Submissions need explicit people and the matching task or document type.');
      if (rows(db, 'family_grants').filter(grant => grant.accountId === recipient.id && grantActive(db, grant)).length >= 20) fail('This collaborator already has 20 active grants. Revoke an unused grant first.', 409);
      quota(db, 'family_grants', 500, 'access grants');
      const recordBindings = Object.fromEntries(recordIds.map(id => { const record = get(db, 'family_records', id);
        return [id, { ownerId: record.ownerId, subjectId: record.subjectId, kind: record.kind }]; }));
      const grant = put(db, 'family_grants', { id: uid(), accountId: recipient.id, grantorId: account.id, label: text(input.label, 'access label', 120),
        recordIds, recordBindings, subjectIds, kinds, includeFuture, permissions, expiresAt: expiry(input.expiresAt, 30), status: 'active', createdAt: stamp(), revokedAt: null });
      audit(db, account.id, action, grant.id); return { grant };
    }
    if (['grant.revoke', 'grant.preview'].includes(action)) {
      object(input, ['id']);
      const grant = get(db, 'family_grants', idText(input.id));
      if (!grant || grant.grantorId !== account.id) fail('This access grant is unavailable.', 404);
      if (action === 'grant.preview') {
        if (!grantActive(db, grant)) fail('This grant has expired or was revoked.', 409);
        return stateFor(db, { account: accountRow(db, grant.accountId), credential: null, grant });
      }
      const now = stamp(); put(db, 'family_grants', { ...grant, status: 'revoked', revokedAt: now });
      db.prepare('UPDATE family_credentials SET revoked_at=? WHERE grant_id=?').run(now, grant.id);
      audit(db, account.id, action, grant.id); return { ok: true };
    }
    if (action === 'credential.create') {
      object(input, ['grantId', 'label', 'expiresAt']);
      const grant = get(db, 'family_grants', idText(input.grantId));
      if (!grant || grant.grantorId !== account.id || !grantActive(db, grant)) fail('Choose an active access grant.', 403);
      const result = mintCredential(db, { accountId: grant.accountId, grantId: grant.id, kind: 'api', creatorId: account.id,
        label: text(input.label ?? grant.label, 'credential label', 120), expiresAt: expiry(input.expiresAt, 30, Date.parse(grant.expiresAt)) });
      audit(db, account.id, action, result.credential.id); return result;
    }
    if (action === 'credential.revoke') {
      object(input, ['id']);
      const credential = credentialRow(db, idText(input.id));
      if (!credential || credential.kind !== 'api' || credential.created_by !== account.id) fail('This credential is unavailable.', 404);
      db.prepare('UPDATE family_credentials SET revoked_at=? WHERE id=?').run(stamp(), credential.id);
      audit(db, account.id, action, credential.id); return { ok: true };
    }
    if (action === 'submission.review') {
      object(input, ['id', 'decision', 'title', 'details', 'date', 'visibility']);
      const submission = get(db, 'family_submissions', idText(input.id));
      if (!submission || submission.recipientId !== account.id || !submissionReadable(db, context, submission)) fail('This submission is unavailable.', 404);
      if (!['accept', 'decline'].includes(input.decision)) fail('Choose accept or decline.');
      const reviewHash = hash(JSON.stringify(stable(input)));
      if (submission.status !== 'pending') {
        if (submission.reviewHash !== reviewHash) fail('This submission was already reviewed.', 409);
        const record = submission.recordId ? get(db, 'family_records', submission.recordId) : null;
        const { reviewHash: ignored, ...view } = submission;
        return { submission: view, ...(record && canReadRecord(db, account, record) ? { record } : {}), replayed: true };
      }
      let record;
      if (input.decision === 'accept') {
        record = saveRecord(db, account, { kind: submission.kind, title: input.title ?? submission.title, details: input.details ?? submission.details,
          date: input.date ?? submission.date, subjectId: submission.subjectId, assigneeId: submission.kind === 'task' ? account.id : '',
          visibility: input.visibility ?? 'private' }, { document: submission.kind === 'document', createdBy: submission.createdBy });
        if (submission.kind === 'document') {
          const file = db.prepare('SELECT * FROM family_files WHERE id=?').get(submission.id);
          if (!file) fail('The uploaded document is unavailable.', 409);
          db.prepare('UPDATE family_files SET id=? WHERE id=?').run(record.id, submission.id);
          Object.assign(record, { filename: file.filename, size: file.size, mime: file.mime }); put(db, 'family_records', record);
        }
      } else if (submission.kind === 'document') db.prepare('DELETE FROM family_files WHERE id=?').run(submission.id);
      const updated = put(db, 'family_submissions', { ...submission, status: input.decision === 'accept' ? 'accepted' : 'declined',
        reviewedAt: stamp(), reviewedBy: account.id, recordId: record?.id || null, reviewHash });
      audit(db, account.id, action, submission.id);
      const { reviewHash: ignored, ...view } = updated;
      return { submission: view, ...(record ? { record } : {}) };
    }
    fail('This family action is not supported.');
  });
}

export function familyDownload(db, actor, recordId) {
  const context = actorContext(db, actor), id = idText(recordId);
  let fileId = null, recipientId = null;
  const record = get(db, 'family_records', id);
  if (record?.kind === 'document' && readForContext(db, context, record)) { fileId = id; recipientId = record.ownerId; }
  if (!fileId) {
    const submission = get(db, 'family_submissions', id);
    if (submission?.kind === 'document' && submissionReadable(db, context, submission) && submission.status !== 'declined') {
      fileId = submission.recordId || submission.id; recipientId = submission.recipientId;
    }
  }
  const file = fileId && db.prepare('SELECT * FROM family_files WHERE id=?').get(fileId);
  if (!file) fail('This document is unavailable.', 404);
  audit(db, context.account.id, 'document.download', id, recipientId);
  return { bytes: Buffer.from(file.bytes), filename: file.filename, mime: file.mime };
}
