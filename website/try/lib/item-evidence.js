import { el,button } from './dom.js';
import { api } from './api.js';
import { refreshBoard } from './store.js';

export function evidenceControls(item) {
  const panel=el('div',{class:'item-evidence',hidden:true});let busy=false;
  const status=el('p',{class:'quiet-note',role:'status'});
  const toggle=button('Source & corrections',{class:'btn quiet','aria-expanded':'false',onClick:async()=>{
    panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(panel.hidden||busy)return;
    busy=true;panel.replaceChildren(el('p',{text:'Checking the original source…'}));
    try{
      const data=await api.itemEvidence(item.id);
      const title=el('input',{class:'input',value:item.headline,'aria-label':'Corrected task title',maxlength:'300'});
      const due=el('input',{class:'input',type:'date',value:item.due_at?.slice(0,10)||'','aria-label':'Corrected deadline'});
      const note=el('textarea',{class:'input',rows:'2',maxlength:'1200',placeholder:'What should Zelos remember about this correction?','aria-label':'Correction note'});
      note.value=data.correction?.note||'';
      const edit=el('div',{class:'item-correction-form',hidden:true},[
        el('label',{},[el('span',{text:'Title'}),title]),el('label',{},[el('span',{text:'Deadline · leave blank if unknown'}),due]),note]);
      const actions=[];
      async function save(decision){
        if(busy)return;busy=true;actions.forEach(b=>{b.disabled=true;});
        try{await api.correctItem(item.id,{decision,...(decision==='corrected'?{headline:title.value,dueAt:due.value||null,note:note.value}:{})});status.textContent='Saved. Future checks will keep your correction.';await refreshBoard();}
        catch(e){status.textContent=e.message;}finally{busy=false;actions.forEach(b=>{b.disabled=false;});}
      }
      const confirm=button('Confirm accurate',{class:'btn quiet',onClick:()=>save('confirmed')});
      const correct=button('Correct this',{class:'btn quiet',onClick:()=>{edit.hidden=false;title.focus();}});
      const dismiss=button('Not a commitment',{class:'btn quiet',onClick:()=>save('dismissed')});
      const apply=button('Save correction',{class:'btn solid',onClick:()=>save('corrected')});actions.push(confirm,correct,dismiss,apply);edit.appendChild(apply);
      panel.replaceChildren(el('strong',{text:data.status}),
        ...data.sources.map(source=>el('div',{class:'item-evidence-source'},[
          el('p',{class:'quiet-note',text:source.available?`${source.author} · ${source.date?new Date(source.date).toLocaleString():'Date not recorded'}`:'Original source is no longer available.'}),
          source.quote?el('blockquote',{text:source.quote}):el('p',{class:'quiet-note',text:'No matching exact quote is available. Review this before treating it as a commitment.'}),
          source.href?.startsWith('#/mail/')?el('a',{href:source.href,text:'Open original email'}):null,
          source.lastSynced?el('p',{class:'quiet-note',text:`Source last synced ${new Date(source.lastSynced).toLocaleString()}`}):null,
        ])),
        el('p',{class:'quiet-note',text:data.correction ? `Reviewed by you on ${new Date(data.correction.updated_at).toLocaleDateString()}.` : 'This is Zelos’s interpretation of the source. Confirm it or correct the details.'}),
        el('div',{class:'item-correction-actions'},actions.slice(0,3)),edit,status);
    }catch(e){panel.replaceChildren(el('p',{class:'quiet-note',text:e.message}));}finally{busy=false;}
  }});
  return {toggle,panel};
}
