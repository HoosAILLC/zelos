/** Fresh saved Money, Progress and Imports context; no model or network calls. */
import { getFinance } from './finance.mjs';
import { getProgress } from './progress.mjs';
import { scrubForPrompt } from './safety.mjs';
import { toZonedISO } from './time.mjs';

const intent = {
  money: /\b(?:money|finances?|financial|transactions?|invoices?|bills?|payments?|spend|spent|spending|expenses?|income|revenue|cash\s?flow|receivables?|payables?|bank|balance|profit|budget|statements?)\b/i,
  progress: /\b(?:progress|accomplished|completed|completion|finished|productivity|weekly report|work done|what did I do)\b/i,
  document: /\b(?:documents?|imports?|imported|uploads?|uploaded|pdfs?|files?|receipts?)\b/i,
};
const inventory = /\b(?:everything|all (?:my|saved|the))\b.*\b(?:data|records|information)\b|\bwhat\b.*\b(?:know about me|(?:data|records|information).*(?:have|access|saved|stored|see))\b|\b(?:can|could|do) you (?:see|read|access)\b.*\b(?:records|data|uploads?)\b/i;
export function personalContextKinds(db,question,history=[]) {
  const q=String(question||'').slice(0,12000);
  const kinds=Object.entries(intent).filter(([,pattern])=>inventory.test(q)||pattern.test(q)).map(([kind])=>kind);
  if (!kinds.includes('money')) {
    const entities=db.prepare('SELECT name FROM finance_entities').all();
    if (entities.some(e=>e.name.length>=4 && q.toLowerCase().includes(e.name.toLowerCase()))) kinds.push('money');
  }
  if (!kinds.length && q.length<400 && /\b(?:that|those|these|them|it|compare|more|why|continue|last month|last week)\b/i.test(q)
      && !/\b(?:health|labs?|blood|sleep|weight|emails?|calendar|weather|news|code|movie)\b/i.test(q)) {
    const prior=[...history].reverse().find(m=>m.role==='assistant' && m.state==='complete');
    for (const kind of Object.keys(intent)) if (prior?.sources?.some(s=>s.kind===kind)) kinds.push(kind);
  }
  return kinds;
}
const clean = value => typeof value==='string' ? scrubForPrompt(value).replaceAll('ZELOS-UNTRUSTED','ZELOS_UNTRUSTED_LITERAL')
  : Array.isArray(value) ? value.map(clean) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])) : value;
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const source=(kind,ref,title,data)=>({source:{kind,ref,title:String(title).slice(0,180),excerpt:JSON.stringify(clean(data)).slice(0,230)},
  block:`[${ref}] ${clean(String(title)).slice(0,180)}\n${JSON.stringify(clean(data))}`});

export function personalChatContext(db,{question='',kinds=[],tz='UTC',now=new Date(),maxChars=24000,maxRecords=80}={}) {
  const at=new Date(now).toISOString(),today=toZonedISO(new Date(now),tz).slice(0,10);
  const candidates=[],headers=[];
  let month=/\b(\d{4}-(?:0[1-9]|1[0-2]))\b/.exec(question)?.[1] || today.slice(0,7);
  if (/\blast month\b/i.test(question)) {const d=new Date(`${today.slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,7);}
  const add=(kind,id,title,data)=>candidates.push(source(kind,`${kind}:${id}`,title,data));
  if (kinds.includes('money')) {
    const money=getFinance(db,{month,today});
    const counts={transactions:db.prepare('SELECT count(*) AS n FROM finance_transactions').get().n,invoices:money.invoices.length,entities:money.entities.length};
    headers.push(source('money','money:summary','Saved Money records',{asOf:at,saved:counts,summary:money.summary,
      meaning:'Amounts are integer cents. Currencies are separate; never add them together. Monthly totals include review rows and exclude transfers/excluded rows; review rows are provisional. These are saved transactions and invoice statuses, not live bank balances. No bank connection is implied.'}));
    for(const e of money.entities)add('money',`entity:${e.id}`,e.name,{...e,accounts:money.accounts.filter(a=>a.entityId===e.id)});
    for(const row of money.invoices)add('money',`invoice:${row.id}`,`Invoice ${row.number} — ${row.counterparty}`,row);
    const transactions=db.prepare('SELECT * FROM finance_transactions ORDER BY date DESC,updated_at DESC,id').all();
    for(const row of transactions)add('money',`transaction:${row.id}`,`${row.date} — ${row.description}`,row);
  }
  if (kinds.includes('progress')) {
    let week=today;
    if (/\blast week\b/i.test(question)){const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-7);week=d.toISOString().slice(0,10);}
    const p=getProgress(db,{week,tz,now:new Date(now)});
    headers.push(source('progress','progress:summary','Saved completion history',{asOf:at,start:p.start,next:p.next,totals:p.totals,reopened:p.reopened,
      recordedSince:p.recordedSince,coverage:p.coverage,meaning:'Completed means recorded as done in Zelos. It is not independent proof that external work happened.'}));
    for(const entry of p.entries)add('progress',`item:${entry.id}`,entry.title,entry);
    for(const entry of p.automatedJobs.entries)add('progress',`job:${entry.id}`,entry.prompt,entry);
  }
  if (kinds.includes('document')) {
    const rows=db.prepare(`SELECT d.*,r.kind AS document_kind,r.created_at AS imported_at FROM document_records d
      JOIN document_reviews r ON r.id=d.review_id ORDER BY d.created_at DESC,d.review_id,d.row_index`).all();
    headers.push(source('document','document:summary','Saved document imports',{asOf:at,savedRows:rows.length,
      savedDocuments:new Set(rows.map(r=>r.review_id)).size,
      meaning:'Only reviewed, committed rows are supplied. Unsaved previews and original full PDF contents are excluded. Reviewed values describe the import; current Money and Health records may have been edited since.'}));
    for(const row of rows)add('document',`${row.review_id}:${row.row_index}`,`Saved ${row.document_kind} row ${row.row_index+1}`,
      {target:row.target,recordKind:row.record_kind,recordId:row.record_id,reviewed:parse(row.reviewed_json),evidence:parse(row.evidence_json),savedAt:row.created_at});
  }
  const terms=[...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[])].filter(t=>!['what','have','saved','show','with','that','this','about','records','everything'].includes(t));
  const rank=entry=>terms.reduce((n,t)=>n+(entry.block.toLowerCase().includes(t)?1:0),0);
  candidates.sort((a,b)=>rank(b)-rank(a));
  const budget=Math.max(0,Math.min(96000,Number(maxChars)||0));
  const selected=[];
  const blocks=headers.map(h=>h.block);
  let size=blocks.join('\n\n').length+700;
  for(const entry of candidates){if(selected.length>=Math.max(0,Math.min(500,maxRecords)))break;if(size+entry.block.length+2<=budget){selected.push(entry);size+=entry.block.length+2;}}
  const coverage=source('library','library:coverage','Records available to this answer',{asOf:at,domains:kinds,
    matchingRecords:candidates.length,includedRecords:selected.length,omittedRecords:candidates.length-selected.length,
    meaning:'Omitted records are still saved; the context has a size limit. Use database totals from each summary for counts, not the number of citation cards. Ask a narrower question to retrieve other records.'});
  const all=[coverage,...headers,...selected];
  const context=all.map(e=>e.block).join('\n\n');
  if(context.length>budget)return {sources:[],context:'Saved context exceeds this answer’s size limit. Ask about one area or a narrower date range.'};
  return {sources:all.map(e=>e.source),context};
}
