import { el } from './dom.js';
import { formatTime,toZonedISO } from './time.js';

export function briefingPanel(data,{tz,running=false}={}) {
  if(!data)return null;
  const group=(title,rows,empty,render,href,count)=>el('section',{class:'brief-group'},[
    el('div',{class:'brief-group-heading'},[el('h3',{text:title}),el('span',{class:'quiet-note',text:String(count)})]),
    rows.length?el('ul',{},rows.map(render)):el('p',{class:'quiet-note',text:empty}),
    rows.length?el('a',{class:'brief-more',href,text:'View all'}):null]);
  const row=(href,title,detail)=>el('li',{},el('a',{href},[el('strong',{text:title}),el('span',{text:detail})]));
  return el('section',{class:'daily-brief','aria-label':'Your daily briefing'},[
    el('div',{class:'brief-heading'},[el('h2',{text:'Today at a glance'}),el('p',{class:'quiet-note',role:'status',text:running?'Checking your connected sources…':data.lastChecked?`Last checked ${new Date(data.lastChecked).toLocaleString()}`:'Waiting for the first completed check.'})]),
    data.syncIssue?el('p',{class:'quiet-note',text:data.syncIssue}):null,
    el('div',{class:'brief-grid'},[
      group('Replies',data.replies,'No recent important replies are waiting.',r=>row(r.href,r.title,`${r.hasDraft?'Draft ready · ':''}${r.person}`),'#/mail',data.counts.replies),
      group('Meetings',data.meetings,'No saved meetings today.',m=>row(m.href,m.title,m.allDay?'All day':`${formatTime(toZonedISO(m.start,tz))}${m.location?` · ${m.location}`:''}`),'#/calendar',data.counts.meetings),
      group('Deadlines',data.deadlines,'No confirmed dates due in the next seven days.',d=>row(d.href,d.title,`${d.overdue?'Overdue · ':''}${d.dueAt.slice(0,10)}${d.confirmed?' · Reviewed by you':''}`),'#/today',data.counts.deadlines),
    ]),
    el('p',{class:'brief-footnote',text:`Replies cover the last ${data.replyWindowDays} days.${data.replyScanLimited?' The newest 2,000 messages were checked.':''} Deadlines use saved source evidence or your corrections.`}),
  ]);
}
