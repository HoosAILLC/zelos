import { getItem, resolveRef } from './db.mjs';
const normalize = text => String(text||'').replace(/\s+/g,' ').trim();
export function itemEvidence(db,id,config) {
  const item=getItem(db,id);if(!item)return null;
  const grounding=item.payload?.grounding,evidence=grounding?.evidence;
  const refs=[...new Set([evidence?.ref,...item.sourceRefs].filter(Boolean))].slice(0,8);
  const own=new Set([config.identity?.email,...(config.mail||[]).map(a=>a.user)].filter(Boolean).map(e=>e.toLowerCase()));
  const sources=refs.map(ref=>{
    const row=resolveRef(db,ref);if(!row)return {ref,available:false};
    const text=row.body||row.snippet||row.description||row.text||'';
    const quote=evidence?.ref===ref ? evidence.quote : null;
    const verified=!!quote && normalize(text).includes(normalize(quote));
    return {ref,available:true,title:row.subject||row.title||'Saved note',
      quote:verified?quote:null,quoteMatches:verified,
      author:row.from_email ? (own.has(row.from_email.toLowerCase())?'You':row.from_name||row.from_email) : row.organizer||'Saved note',
      date:row.sent_at||row.starts_at||row.created_at||null,lastSynced:row.fetched_at||null,
      ...(ref.startsWith('msg:')?{href:`#/mail/${encodeURIComponent(ref.slice(4))}`}:{})};
  });
  return {itemId:id,bucket:item.bucket,person:item.person||null,dueAt:item.due_at,
    deadlineEvidence:grounding?.deadlineEvidence||null,checkedAt:grounding?.checkedAt||null,
    correction:item.payload?.userCorrection||null,sources,
    status:item.payload?.userCorrection ? 'Reviewed by you' : sources.some(s=>s.quoteMatches)?'Source-backed suggestion':'Needs your review'};
}
