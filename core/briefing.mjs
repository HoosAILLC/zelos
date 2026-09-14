/** A current, factual daily brief from saved records. No invented urgency. */
import { getMessage, lastRun, resolveRef } from './db.mjs';
import { importanceContext, importanceFor, draftRevision, getMailMessage } from './mail-workspace.mjs';
import { replyRequest } from './mail-autodrafts.mjs';
import { toZonedISO, addDaysToKey } from './time.mjs';

export function dailyBriefing(db,config,{items=[],events=[],now=new Date()}={}) {
  const tz=config.identity?.timezone||'UTC',at=new Date(now).toISOString(),today=toZonedISO(now,tz).slice(0,10);
  const accounts=(config.mail||[]).filter(a=>a.enabled===true).map(a=>a.id),context=importanceContext(db,accounts),replies=[];
  const cutoff=new Date(new Date(now).getTime()-7*86400000).toISOString();
  const recent=db.prepare(`SELECT id FROM messages WHERE direction='in' AND julianday(sent_at)>=julianday(?)
    AND julianday(sent_at)<=julianday(?) ORDER BY julianday(sent_at) DESC,id LIMIT 2001`).all(cutoff,at);
  for (const {id} of recent.slice(0,2000)) {
    const message=getMessage(db,id);
    if(!accounts.includes(message.source_id)||!importanceFor(message,context).important)continue;
    if(['sending','sent','uncertain'].includes(context.deliveries.get(id)))continue;
    if(message.thread_key && db.prepare(`SELECT 1 FROM messages WHERE source_id=? AND thread_key=? AND julianday(sent_at)>julianday(?) LIMIT 1`)
      .get(message.source_id,message.thread_key,message.sent_at))continue;
    const request=replyRequest(message);
    const hasDraft=!!draftRevision(db,id),detail=hasDraft?getMailMessage(db,config,id):null;
    if(!request && !detail?.draft)continue;
    if(hasDraft && !detail?.draft)continue;
    if(!hasDraft && importanceFor(message,context,{ignoreChoice:true}).category!=='conversation')continue;
    replies.push({id,title:message.subject||'(No subject)',person:message.from_name||message.from_email,
      date:message.sent_at,quote:request,hasDraft:!!detail?.draft,href:`#/mail/${encodeURIComponent(id)}`});
  }
  const meetings=events.filter(e=>!['cancelled','canceled'].includes(String(e.status).toLowerCase()) && String(e.rsvp).toLowerCase()!=='declined')
    .filter(e=>e.all_day ? e.starts_at?.slice(0,10)<=today && (e.ends_at?.slice(0,10)||addDaysToKey(e.starts_at?.slice(0,10),1))>today
      : toZonedISO(e.starts_at,tz)?.slice(0,10)===today)
    .sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at)))
    .map(e=>({id:e.id,title:e.title,start:e.starts_at,end:e.ends_at,allDay:!!e.all_day,location:e.location||'',href:'#/calendar'}));
  const currentDeadline=i=>{const proof=i.payload?.grounding?.deadlineEvidence;if(!proof?.ref||!proof?.quote)return false;const row=resolveRef(db,proof.ref);return !!row && String(row.body||row.snippet||row.description||row.text||'').replace(/\s+/g,' ').includes(String(proof.quote).replace(/\s+/g,' '));};
  const deadlineItems=items.filter(i=>i.state==='open'&&!i.sourceInactive&&!i.payload?.accuracyReviewRequired && i.due_at
    && (i.payload?.userCorrection||currentDeadline(i)) && i.due_at.slice(0,10)<=addDaysToKey(today,7));
  const overdue=i=>i.due_at.length===10 ? i.due_at<today : Date.parse(i.due_at)<new Date(now).getTime();
  const deadlines=deadlineItems.sort((a,b)=>String(a.due_at).localeCompare(String(b.due_at)))
    .map(i=>({id:i.id,title:i.headline,dueAt:i.due_at,overdue:overdue(i),confirmed:!!i.payload?.userCorrection,
      href:i.sourceRefs?.find(ref=>ref.startsWith('msg:')) ? `#/mail/${encodeURIComponent(i.sourceRefs.find(ref=>ref.startsWith('msg:')).slice(4))}`:'#/today'}));
  const last=lastRun(db);
  return {date:today,asOf:at,lastChecked:last?.ended_at||null,
    syncIssue:last?.ok===false?'The last check did not finish.':last?.stats?.sourcesFailed?'Some sources could not be read.':null,
    counts:{replies:replies.length,meetings:meetings.length,deadlines:deadlines.length,overdue:deadlines.filter(d=>d.overdue).length},
    replies:replies.slice(0,5),meetings:meetings.slice(0,5),deadlines:deadlines.slice(0,5),
    replyWindowDays:7,replyScanLimited:recent.length>2000};
}
