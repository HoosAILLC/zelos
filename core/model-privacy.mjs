/** Shared boundary for model access to saved Health and personal records. */
import { isLocalAddress } from './llm.mjs';
import { needsHealthContext } from './health-context.mjs';
import { personalContextKinds } from './personal-context.mjs';

export const LOCAL_RECORDS_MESSAGE = 'Health and saved personal records require your local model. Select it in Settings to continue.';
const PRIVATE_KINDS = new Set(['health', 'money', 'progress', 'document', 'library']);
const PRIVATE_TOOLS = new Set(['read_health', 'read_money', 'read_progress', 'weekly_report']);
const EXPLICIT_PRIVATE_REQUEST = /\b(?:read_health|read_money|read_progress|weekly_report|medications?|medicines?|prescriptions?|diagnosis|diagnoses|diagnosed|dosages?|medical\s+conditions?|diseases?|illness(?:es)?)\b/i;

export function isPrivateRecordsModel(model) {
  let url; try { url = new URL(model?.baseUrl); } catch { return false; }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && isLocalAddress(url.href);
}
export function toolRequiresLocalModel(name) { return PRIVATE_TOOLS.has(name); }
export function hasPrivateRecordSources(sources) {
  return Array.isArray(sources) && sources.some(source => PRIVATE_KINDS.has(source?.kind)
    || PRIVATE_KINDS.has(String(source?.ref || '').split(':', 1)[0]));
}
/** Protect user-entered facts before the first request and retained facts after
 * a provider change, even when the new turn is about an ordinary topic. */
export function requiresPrivateRecordsModel(db, question, history = []) {
  const privatePrompt = text => EXPLICIT_PRIVATE_REQUEST.test(String(text || '')) || needsHealthContext(db, text) || personalContextKinds(db, text).length > 0;
  return privatePrompt(question) || history.some(message => hasPrivateRecordSources(message?.sources)
    || message?.role === 'user' && privatePrompt(message.content));
}
