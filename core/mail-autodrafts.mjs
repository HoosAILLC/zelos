/** Bounded local reply preparation. There is deliberately no sending capability. */
import crypto from 'node:crypto';
import { getMessage, setKV } from './db.mjs';
import { generateReply } from './mail-draft.mjs';
import { draftDefaults, draftRevision, importanceContext, importanceFor, saveAutomaticReply } from './mail-workspace.mjs';
import { automaticDraftsEnabled } from './mail-preferences.mjs';
import { isLocalAddress } from './llm.mjs';

const DAY = 86400000;
const autoSender = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|notifications?|alerts?|mailer|bounce|news|marketing|offers?)(?:[._+@-]|$)/i;
export function authoredMail(value) {
  return String(value || '').split(/(?:^|\n)\s*(?:On .{0,300}wrote:|From:|Begin forwarded message:|[-_]{2,}\s*(?:Original|Forwarded) Message)/i)[0]
    .split('\n').filter(line=>!/^\s*>/.test(line)).join('\n').slice(0,12000);
}
export function replyRequest(message) {
  if (autoSender.test(message.from_email || '')) return '';
  const content = authoredMail(message.body || message.snippet);
  if (/\b(?:no (?:reply|response|action) (?:is )?(?:needed|required)|do not reply|don't reply|for (?:your )?information only)\b/i.test(content)) return '';
  const parts = content.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);
  return parts.find(part=>part.length >= 12 && part.length <= 700 && (
    /\b(?:can|could|would|will) you\b|\b(?:please|let me know)\b/i.test(part)
    || /^(?:what|which|when|where|how|are you|do you|have you|is there)\b.*\?$/i.test(part))) || '';
}
function currentThread(db,message) {
  if (!message.thread_key) return null;
  return db.prepare(`SELECT id,sent_at,body,subject,from_email FROM messages WHERE source_id=? AND thread_key=?
    ORDER BY julianday(sent_at) DESC,id DESC LIMIT 1`).get(message.source_id,message.thread_key);
}
export function automaticCandidate(db,config,message,context,{ now=Date.now() }={}) {
  const account = config.mail?.find(a=>a.id===message.source_id && a.enabled===true);
  if (!account || message.direction!=='in' || !message.reply_headers_known) return null;
  const sent = Date.parse(message.sent_at);
  if (!Number.isFinite(sent) || sent < now-7*DAY || sent > now+300000) return null;
  const to = message.to || [];
  if (!to.some(a=>String(typeof a==='string'?a:a.email||'').toLowerCase()===String(account.user).toLowerCase())) return null;
  if (!importanceFor(message,context).important) return null;
  if (importanceFor(message,context,{ignoreChoice:true}).category!=='conversation') return null;
  if (draftRevision(db,message.id) || context.deliveries.has(message.id)) return null;
  const latest = currentThread(db,message);
  if (latest && latest.id!==message.id) return null;
  const quote = replyRequest(message);
  const defaults = draftDefaults(db,config,message.id);
  if (!quote || !defaults.to || autoSender.test(defaults.to)) return null;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([message.id,message.source_id,
    message.from_email,message.to,message.replyTo,message.subject,message.body,message.snippet,message.sent_at,
    message.references,message.in_reply_to,latest,defaults])).digest('hex');
  return { quote, fingerprint };
}

export async function prepareAutomaticDrafts({ db,config,signal,generate=generateReply,now=Date.now(),limit=3,onProgress }={}) {
  const summary={enabled:automaticDraftsEnabled(db),prepared:0,checked:0,failed:0,tokensIn:0,tokensOut:0,at:new Date(now).toISOString()};
  if (!summary.enabled) return summary;
  let url;try{url=new URL(config.model?.baseUrl);}catch{}
  if (!url || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !isLocalAddress(url.href)) {
    summary.issue='Automatic replies require your local model. Select it in Settings to continue.';
    setKV(db,'mail.autoDrafts.lastCheck',JSON.stringify(summary));return summary;
  }
  const ids=(config.mail||[]).filter(a=>a.enabled===true).map(a=>a.id);
  const context=importanceContext(db,ids);
  const candidates=db.prepare(`SELECT id FROM messages WHERE direction='in' AND julianday(sent_at)>=julianday(?)
    ORDER BY julianday(sent_at) DESC,id DESC LIMIT 2000`).all(new Date(now-7*DAY).toISOString());
  for (const {id} of candidates) {
    signal?.throwIfAborted();
    if (!automaticDraftsEnabled(db) || summary.checked>=Math.min(5,Math.max(1,limit))) break;
    const message=getMessage(db,id),candidate=automaticCandidate(db,config,message,context,{now});
    if (!candidate) continue;
    const previous=db.prepare('SELECT * FROM mail_autodrafts WHERE message_id=?').get(id);
    if (previous?.fingerprint===candidate.fingerprint && (previous.status!=='failed' || previous.attempts>=3 || now-Date.parse(previous.updated_at)<3600000)) continue;
    const attempts=previous?.fingerprint===candidate.fingerprint ? previous.attempts+1 : 1;
    const save=(status,reason,draftId=null)=>db.prepare(`INSERT INTO mail_autodrafts(message_id,fingerprint,status,reason,request_quote,draft_id,attempts,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status,
      reason=excluded.reason,request_quote=excluded.request_quote,draft_id=excluded.draft_id,attempts=excluded.attempts,updated_at=excluded.updated_at`)
      .run(id,candidate.fingerprint,status,reason,candidate.quote,draftId,attempts,new Date().toISOString());
    summary.checked++;onProgress?.('Preparing a reply for your review…');
    // Per-message failures are isolated from synchronization and the next email.
    const timed = AbortSignal.timeout(150000);
    const workSignal = signal ? AbortSignal.any([signal,timed]) : timed;
    try {
      const defaults=draftDefaults(db,config,id);
      const result=await generate({db,config,messageId:id,accountId:defaults.accountId,to:defaults.to,instructions:'',now:new Date(now).toISOString(),signal:workSignal});
      summary.tokensIn+=Number(result.usage?.input)||0;summary.tokensOut+=Number(result.usage?.output)||0;
      workSignal.throwIfAborted();
      const fresh=automaticCandidate(db,config,getMessage(db,id),importanceContext(db,ids),{now:Date.now()});
      if (!automaticDraftsEnabled(db) || !fresh || fresh.fingerprint!==candidate.fingerprint) continue;
      // No await between the final revision check and save: user edits win.
      const draft=saveAutomaticReply(db,config,id,result.body);
      save('ready','Prepared from the original email. Review the reply before sending.',draft.id);summary.prepared++;
    } catch(error) {
      signal?.throwIfAborted();
      summary.tokensIn+=Number(error.usage?.input)||0;summary.tokensOut+=Number(error.usage?.output)||0;
      const unsupported=['unsupported_draft_claim','unfinished_draft','unsafe_draft'].includes(error.code);
      save(unsupported?'needs_review':'failed',unsupported?'This reply needs your facts or a decision. Open the email to add instructions.':'The local model could not prepare this reply. Zelos will try again later.');summary.failed++;
    }
  }
  setKV(db,'mail.autoDrafts.lastCheck',JSON.stringify(summary));
  return summary;
}
