import { el, button } from '../lib/dom.js';
import { api } from '../lib/api.js';
let root, field, status, list, buttonAssign, loading=false;
const LABEL={queued:'Queued',running:'Working',completed:'Completed',needs_input:'Needs your input',failed:'Could not finish',cancelled:'Cancelled'};
function artifactsFor(job) {
  // A later failed/cancelled step must not hide an artifact already created.
  const seen=new Set();
  return [...(job.result?.artifacts||[]),...(job.steps||[]).filter(step=>step.status==='complete').map(step=>step.result)]
    .filter(artifact=>{
      const key=artifact?.download||artifact?.reviewUrl;
      if(typeof key!=='string'||seen.has(key))return false;
      seen.add(key);return true;
    });
}
async function downloadReport(jobId) {
  const blob=await api.jobReport(jobId),url=URL.createObjectURL(blob),link=el('a',{href:url,download:'zelos-weekly-report.pdf'});
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function load(){
  if(loading)return;loading=true;
  try{
    const data=await api.jobs();
    list.replaceChildren(...data.jobs.map(job=>el('article',{class:'job-card'},[
      el('div',{class:'job-card-top'},[el('h2',{text:job.prompt}),el('span',{class:`job-state is-${job.status}`,text:LABEL[job.status]||job.status})]),
      el('p',{class:'quiet-note',text:new Date(job.created_at).toLocaleString()}),
      job.steps?.length?el('details',{},[el('summary',{text:`${job.steps.length} work steps`}),el('ol',{class:'job-steps'},job.steps.map(step=>el('li',{},[
        el('strong',{text:step.tool.replaceAll('_',' ')}),el('span',{text:` · ${step.status}`}),step.error?el('p',{text:step.error}):null,
      ])))]):null,
      job.result?.text?el('div',{class:'job-result',text:job.result.text}):null,
      job.error?el('p',{class:'job-error',text:job.error}):null,
      el('div',{class:'row-inline'},[
        ...(artifactsFor(job).map(artifact=>artifact.download===`/api/assistant/jobs/${job.id}/report.pdf`
          ?button('Download report',{class:'btn solid',onClick:()=>downloadReport(job.id).catch(error=>{status.textContent=error.message;})})
          :typeof artifact.reviewUrl==='string'&&/^#\/mail\/draft\/[A-Za-z0-9_.:-]+$/.test(artifact.reviewUrl)?el('a',{class:'btn solid',href:artifact.reviewUrl,text:'Review email draft'}):null)),
        ['queued','running'].includes(job.status)?button('Stop task',{class:'btn quiet',onClick:async()=>{try{await api.cancelJob(job.id);await load();}catch(error){status.textContent=error.message;}}}):null,
        ['needs_input','failed','completed','cancelled'].includes(job.status)?button('Assign follow-up',{class:'btn quiet',onClick:()=>{field.value=`Follow up on: ${job.prompt}\n\n`;field.focus();}}):null,
      ]),
    ])));
    if(!data.jobs.length)list.appendChild(el('p',{class:'quiet-note',text:'No assigned tasks yet. Ask Zelos to prepare a weekly report, find an answer in your records, or draft a reply.'}));
  }catch(error){status.textContent=error.message;}finally{loading=false;}
}
export function renderJobs(){
  if(!root){
    field=el('textarea',{class:'input',rows:4,'aria-label':'Task for Zelos',placeholder:'Prepare a report of what I completed this week…'});
    status=el('p',{class:'quiet-note',role:'status'});list=el('div',{class:'job-list'});
    buttonAssign=button('Assign to Zelos',{class:'btn solid',onClick:async()=>{
      const prompt=field.value.trim();
      if(!prompt)return;buttonAssign.disabled=true;status.textContent='Adding your task…';
      try{await api.assignJob(prompt);if(field.value.trim()===prompt)field.value='';status.textContent='Example result prepared in this tab. Reloading resets the demo.';await load();}
      catch(error){status.textContent=error.message;}finally{buttonAssign.disabled=false;}
    }});
    root=el('div',{class:'view view-jobs'},[
      el('h1',{text:'Assigned to Zelos'}),el('p',{class:'panel-lede',text:'Explore assigned work with prepared example results. This browser demo has no live model or background worker.'}),
      field,el('div',{class:'row-inline'},[buttonAssign,button('Refresh',{class:'btn quiet',onClick:load})]),status,
      el('p',{class:'quiet-note',text:'Zelos can research your saved records, save notes, create weekly PDFs, and prepare unsent email replies. Each completed step is recorded below.'}),list,
    ]);
    setInterval(()=>{if(root?.isConnected)load();},4000);
  }
  load();return root;
}
