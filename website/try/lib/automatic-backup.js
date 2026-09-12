import {el,button} from './dom.js';
import {api} from './api.js';
export function automaticBackupPanel(){
  if(typeof api.automaticBackup!=='function')return null;
  const message=el('p',{class:'quiet-note',role:'status',text:'Checking local backups…'});
  const enabled=el('input',{type:'checkbox','aria-label':'Daily encrypted backups'});
  const run=button('Back up now',{class:'btn quiet',disabled:true,onClick:async()=>{run.disabled=true;message.textContent='Creating and verifying an encrypted recovery copy…';try{paint(await api.runAutomaticBackup());}catch(e){message.textContent=e.message;}finally{run.disabled=false;}}});
  function paint(data){enabled.checked=data.enabled;run.disabled=false;message.textContent=data.last?.ok
    ? `Last verified ${new Date(data.last.at).toLocaleString()} · ${data.copies} of ${data.retention} local copies.`
    : data.last?.error || 'No automatic backup has finished yet.';}
  enabled.disabled=true;
  enabled.addEventListener('change',async()=>{enabled.disabled=true;try{paint(await api.saveAutomaticBackup({enabled:enabled.checked}));}catch(e){enabled.checked=!enabled.checked;message.textContent=e.message;}finally{enabled.disabled=false;}});
  api.automaticBackup().then(data=>{paint(data);enabled.disabled=false;}).catch(e=>{message.textContent=e.message;});
  return el('div',{class:'automatic-backup-panel'},[el('h3',{text:'Daily encrypted backups'}),
    el('label',{},[enabled,el('span',{text:'Save a verified recovery copy every day'})]),
    el('p',{class:'quiet-note',text:'Keeps the latest seven copies on your Spark, including saved records and connection settings. The recovery key stays separately on the Spark. A separate device copy is needed for protection against loss of the Spark.'}),message,run]);
}
