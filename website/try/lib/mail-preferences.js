import { el, button } from './dom.js';
import { api } from './api.js';

export function mailPreferencesPanel(onChange=()=>{}) {
  const panel=el('div',{class:'mail-preferences-body',hidden:true});
  const status=el('p',{class:'quiet-note',role:'status'});
  let busy=false;
  async function load(){
    if(busy)return;busy=true;status.textContent='Loading email preferences…';
    try{render(await api.mailPreferences());status.textContent='';}catch(e){status.textContent=e.message;}finally{busy=false;}
  }
  function render(data){
    const auto=el('input',{type:'checkbox','aria-label':'Prepare replies automatically'});auto.checked=data.automaticDrafts;
    auto.addEventListener('change',async()=>{auto.disabled=true;try{const result=await api.saveMailPreferences({automaticDrafts:auto.checked});render(result);status.textContent=auto.checked?'Automatic reply drafts are on.':'Automatic reply drafts are paused.';}catch(e){auto.checked=!auto.checked;status.textContent=e.message;}finally{auto.disabled=false;}});
    panel.replaceChildren(...[el('label',{class:'mail-auto-toggle'},[auto,el('strong',{text:'Prepare replies automatically'})]),
      el('p',{class:'quiet-note',text:'During your regular checks, Nemotron prepares replies to recent important emails that ask for an answer. Existing drafts stay yours. Sending always waits for you.'}),
      el('p',{class:'quiet-note',text:`${data.ready||0} prepared ${data.ready===1?'reply':'replies'} ready to review.${data.lastCheck?.at ? ` Last checked ${new Date(data.lastCheck.at).toLocaleString()}.` : ''}`}),
      data.lastCheck?.issue ? el('p',{class:'quiet-note',text:data.lastCheck.issue}) : null,
      el('h3',{text:'What Zelos has learned'}),
      ...(data.rules?.length ? data.rules.map(rule=>{
        const remove=button('Forget',{class:'btn quiet',onClick:async()=>{remove.disabled=true;try{render(await api.forgetMailRule(rule.id));onChange();}catch(e){status.textContent=e.message;remove.disabled=false;}}});
        return el('div',{class:'mail-learned-rule'},[el('div',{},[el('strong',{text:rule.sender}),el('p',{class:'quiet-note',text:`${rule.important?'Keep in Important':'Filter out'} · ${rule.category==='*'?'All emails from this sender':rule.category.replaceAll('_',' ')}`})]),remove]);
      }) : [el('p',{class:'quiet-note',text:'Correct a message below to teach Zelos about similar emails or an entire sender.'})])].filter(Boolean));
  }
  const toggle=button('Email preferences',{class:'btn quiet','aria-expanded':'false',onClick:()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)load();}});
  return el('div',{class:'mail-preferences'},[toggle,status,panel]);
}
