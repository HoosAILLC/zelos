/** Shared family workspace. All record access is decided by the server. */
const KINDS = ['task', 'plan', 'event', 'tracking', 'note', 'document'];
const KIND_NAMES = {task:'Task',plan:'Plan',event:'Event',tracking:'Tracking',note:'Note',document:'Document'};
const list = value => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
export function normalizeFamilyState(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  return {...raw, family:raw.family || {}, me:raw.me || {}, permissions:raw.permissions || {}, portal:raw.portal || {},
    ...Object.fromEntries(['members','children','records','grants','submissions','activity','invitations','credentials'].map(key => [key,list(raw[key])]))};
}
export function familyInviteUrl(portal, token) {
  if (!portal?.ready || !portal.url || !token) return '';
  try { const url = new URL(portal.url); if (!['http:','https:'].includes(url.protocol) || url.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) return ''; url.pathname = '/'; url.search = ''; url.hash = new URLSearchParams({invite:token}).toString(); return url.href; } catch { return ''; }
}
export function familyGrantActive(grant, now = Date.now()) {
  return !grant.revokedAt && grant.status !== 'revoked' && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now);
}
export function familySubmissionSubjects(grant) {
  return [...new Set(Array.isArray(grant?.subjectIds) ? grant.subjectIds.filter(id=>typeof id==='string' && id) : [])];
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name,value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'text') node.textContent = String(value);
    else if (name === 'class') node.className = value;
    else if (name === 'checked' || name === 'disabled' || name === 'hidden' || name === 'required' || name === 'multiple' || name === 'readOnly') node[name] = Boolean(value);
    else node.setAttribute(name,String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children]).flat()) if (child !== null && child !== undefined && child !== false && child !== 0) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const note = text => el('p',{class:'family-note',text});
const badge = text => el('span',{class:'family-badge',text});
const section = (title,children,description='') => el('section',{class:'family-panel'},[el('h2',{text:title}),description && note(description),...children]);
const actions = (...children) => el('div',{class:'family-actions'},children);
const field = (label,input,hint='') => el('label',{class:'family-field'},[el('span',{text:label}),input,hint && note(hint)]);
function textInput(value='',type='text',attrs={}) { return el('input',{class:'family-input',type,value:value || '',...attrs}); }
function select(options,value='') { const node=el('select',{class:'family-input'},options.map(([id,label])=>el('option',{value:id,text:label})));node.value=options.some(([id])=>String(id)===String(value || ''))?String(value || ''):String(options[0]?.[0] || '');return node; }
function check(label,checked=false,description='') { const input=el('input',{type:'checkbox',checked});return {input,node:el('label',{class:'family-check'},[input,el('span',{},[el('span',{text:label}),description && note(description)])])}; }
function chooseMany(options,values=[]) { const items=options.map(([id,label])=>({id,...check(label,values.includes(id))}));return {node:el('div',{class:'family-choices'},items.map(item=>item.node)),values:()=>items.filter(item=>item.input.checked).map(item=>item.id),items}; }
function dateLabel(value) { if (!value) return ''; const date=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function expiryInput(days=30) { return textInput(new Date(Date.now()+days*86400000).toISOString().slice(0,10),'date',{required:true,min:new Date().toISOString().slice(0,10),max:new Date(Date.now()+365*86400000).toISOString().slice(0,10)}); }
function expiryValue(input) { return new Date(`${input.value}T23:59:59`).toISOString(); }
function uid() { return globalThis.crypto?.randomUUID?.() || `family-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function fileBase64(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('The document could not be read.'));reader.readAsDataURL(file);}); }
async function copyText(value) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(value);return true; } catch {} }
  return false;
}

export function mountFamily(root,{request,download,portalUrl,mode='owner',publishSources,publishSnapshot,reviewDocument}={}) {
  if (typeof request !== 'function') throw new Error('Family request function is required.');
  let state=null,tab='family',editor=null,preview=null,revealed=null,busy=false,destroyed=false,message='',messageError=false;
  let filterKind='',filterSubject='',filterText='';
  const messageNode=el('p',{class:'family-status',role:'status','aria-live':'polite',hidden:true});
  const body=el('div',{class:'family-body'});
  root.classList.add('family-app');
  function say(text,error=false) { message=text;messageError=error;messageNode.textContent=text;messageNode.hidden=!text;messageNode.classList.toggle('is-error',error);messageNode.setAttribute('role',error?'alert':'status'); }
  function button(label,fn,{primary=false,disabled=false,className=''}={}) { const b=el('button',{type:'button',class:`family-button ${primary?'is-primary':''} ${className}`,text:label,disabled:disabled});b.addEventListener('click',()=>{if(!busy)fn();});return b; }
  function setBusy(value) {
    busy=value;root.setAttribute('aria-busy',String(value));
    for(const control of root.querySelectorAll('button,input,select,textarea')) {
      if(value){control.dataset.familyWasDisabled=String(control.disabled);control.disabled=true;}
      else if('familyWasDisabled' in control.dataset){control.disabled=control.dataset.familyWasDisabled==='true';delete control.dataset.familyWasDisabled;}
    }
  }
  async function perform(operation,{success='',close=true,reload=true}={}) {
    if(busy || destroyed)return;setBusy(true);say('');let completed=false;
    try {const result=await operation();completed=true;if(close)editor=null;if(reload)state=normalizeFamilyState(await request(null));if(success)say(typeof success==='function'?success(result):success);return result;}
    catch(error){say(error?.message || 'Something went wrong. Try again.',true);}
    finally{setBusy(false);if((completed || !state) && !destroyed)paint();}
  }
  const mutate=(action,input,options={})=>perform(()=>request(action,input),options);
  async function refresh(){return perform(async()=>{state=normalizeFamilyState(await request(null));},{reload:false,close:false});}
  function parent(){return state?.me.role==='owner' || state?.me.role==='parent';}
  function members(){return state.members.filter(m=>m.status!=='revoked' && m.role!=='collaborator');}
  function personName(id,data=state){return id===data.me.id?'You':data.members.find(m=>m.id===id)?.name || 'Family member';}
  function subjectName(id,data=state){return id?data.children.find(c=>c.id===id)?.name || 'Child profile':'Personal / adult';}
  function subjectOptions(){return [['','Personal / adult'],...state.children.map(c=>[c.id,c.name])];}
  function editable(record){return parent() && (record.ownerId===state.me.id || record.visibility==='family' && (!record.subjectId || state.children.some(c=>c.id===record.subjectId && (c.guardianIds || []).includes(state.me.id))));}
  function portal(){const value={...state.portal,url:state.portal.url || portalUrl || '',published:state.portal.published===true};if(mode==='guest' && value.ready===undefined){try{const url=new URL(value.url);value.ready=url.origin===window.location.origin;}catch{value.ready=false;}}return value;}
  function openEditor(title,content){editor=section(title,content);editor.classList.add('family-editor');editor.setAttribute('aria-label',title);paint();editor.querySelector('input,select,textarea,button')?.focus({preventScroll:true});editor.scrollIntoView({block:'nearest',behavior:'smooth'});}
  function closeEditor(){editor=null;paint();}
  function form(content,onSubmit,label='Save') {const f=el('form',{class:'family-form'},[...content,actions(el('button',{type:'submit',class:'family-button is-primary',text:label}),button('Cancel',closeEditor))]);f.addEventListener('submit',event=>{event.preventDefault();if(!busy && f.reportValidity())onSubmit();});return f;}
  function confirmAction(title,description,action,input){openEditor(title,[note(description),actions(button(title,()=>mutate(action,input,{success:`${title.replace(/^Revoke /,'Revoked ').replace(/^Remove /,'Removed ')}.`}),{primary:true}),button('Cancel',closeEditor))]);}

  function recordForm(record={}) {
    const kind=select(KINDS.filter(k=>k!=='document' || record.id && record.kind==='document').map(k=>[k,KIND_NAMES[k]]),record.kind || 'task');
    if(record.id)kind.disabled=true;
    const title=textInput(record.title,'text',{required:true,maxlength:200});
    const details=el('textarea',{class:'family-input',rows:5,maxlength:20000,text:record.details || ''});
    const date=textInput(record.date,'date');const subject=select(subjectOptions(),record.subjectId);
    const assignee=select([['','Unassigned'],...members().filter(m=>m.status==='active').map(m=>[m.id,m.id===state.me.id?'You':m.name])],record.assigneeId ?? ((record.kind || 'task')==='task'?state.me.id:''));
    const updateAssignees=()=>{const previous=assignee.value,child=state.children.find(c=>c.id===subject.value);assignee.replaceChildren(el('option',{value:'',text:'Unassigned'}),...members().filter(m=>m.status==='active' && (!child || (child.guardianIds || []).includes(m.id))).map(m=>el('option',{value:m.id,text:m.id===state.me.id?'You':m.name})));assignee.value=[...assignee.options].some(o=>o.value===previous)?previous:'';};subject.addEventListener('change',updateAssignees);updateAssignees();
    const visibility=select([['private','Only me'],['family','Shared with family']],record.visibility || 'private');
    const status=select([['open','Open'],['done','Done']],record.status || 'open');
    if(record.id && record.ownerId!==state.me.id){subject.disabled=true;visibility.disabled=true;}
    openEditor(record.id?'Edit record':'Create a record',[form([
      el('div',{class:'family-grid'},[field('Type',kind),field('About',subject)]),field('Title',title),field('Details',details,'For tracking, include the measurement, value, and unit here.'),
      el('div',{class:'family-grid'},[field('Date',date),field('Assigned to',assignee,'Task recipient is separate from the child it concerns. Tasks assigned to another parent must be shared with family.'),field('Visibility',visibility),field('Status',status)]),
      note('Only me keeps this record out of the other parent’s family view. Access grants you create can separately share it with collaborators. Shared child records are visible to their designated guardians.'),
    ],()=>mutate('record.save',{...(record.id?{id:record.id,version:record.version}:{}),kind:record.kind || kind.value,title:title.value,details:details.value,date:date.value,subjectId:subject.value,assigneeId:assignee.value,visibility:visibility.value,status:status.value},{success:'Record saved.'}),record.id?'Save changes':'Create record')]);
  }
  function childForm(child={}) {
    const name=textInput(child.name,'text',{required:true,maxlength:120}),birthday=textInput(child.birthday,'date');
    const notes=el('textarea',{class:'family-input',rows:3,maxlength:4000,text:child.notes || ''});
    const guardians=chooseMany(members().filter(m=>m.status==='active').map(m=>[m.id,m.id===state.me.id?'You':m.name]),child.guardianIds || [state.me.id]);
    openEditor(child.id?'Edit child profile':'Add a child',[form([field('Name',name),field('Birthday (optional)',birthday),field('Profile notes',notes,'These notes are visible to the child’s guardians.'),el('fieldset',{class:'family-fieldset'},[el('legend',{text:'Parents who manage this profile'}),guardians.node]),note('A child profile does not need an account or password.')],()=>{
      if(!guardians.values().length){say('Choose at least one parent to manage this profile.',true);return;}
      mutate('child.save',{...(child.id?{id:child.id}:{}),name:name.value,birthday:birthday.value,notes:notes.value,guardianIds:guardians.values()},{success:'Child profile saved.'});
    },child.id?'Save profile':'Add child')]);
  }
  function familySettings(){const name=textInput(state.family.name,'text',{required:true,maxlength:120});openEditor('Family name',[form([field('Name',name)],()=>mutate('family.update',{name:name.value},{success:'Family name saved.'}))]);}
  function accountSettings(){const name=textInput(state.me.name,'text',{required:true,maxlength:120});openEditor('Your display name',[form([field('Name',name)],()=>mutate('account.update',{name:name.value},{success:'Your name was updated.'}))]);}
  function inviteForm(){
    const name=textInput('','text',{required:true,maxlength:120}),email=textInput('','email',{required:true,maxlength:254});
    const role=select(state.me.role==='owner'?[['parent','Parent'],['collaborator','Trainer, advisor, or collaborator']]:[['collaborator','Trainer, advisor, or collaborator']]);
    const expires=expiryInput(7);
    openEditor('Invite someone',[form([el('div',{class:'family-grid'},[field('Name',name),field('Email',email)]),field('Role',role),field('Invitation expires',expires),note('Parents get a separate account. Collaborators see only the access you grant. Zelos creates an invitation link; it does not send an email.'),!portal().published && note(portal().ready?(mode==='guest'?'The invitation opens this guest portal. Its recipient must be able to reach this address.':'The portal is currently a local preview. Its link works only where that local address is reachable.'):'The guest portal is unavailable. You can create an invitation, but a reachable portal is needed to accept it.')],()=>perform(async()=>{
      const result=await request('member.invite',{name:name.value,email:email.value,role:role.value,expiresAt:expiryValue(expires)});
      const link=familyInviteUrl(portal(),result.inviteToken);
      revealed={title:link?(portal().published?'Invitation link':mode==='guest'?'Invitation link · this portal':'Local invitation link'):'Invitation code',value:link || result.inviteToken,description:`For ${email.value}. Copy this now; the secret is shown only once.${link?'':' The guest portal must be available to accept this invitation.'}`};
      return result;
    },{success:'Invitation created. Copy the link below.'}),'Create invitation')]);
  }
  function grantForm(){
    const collaborators=state.members.filter(m=>m.role==='collaborator' && m.status!=='revoked');
    if(!collaborators.length){openEditor('Create access',[note('Invite a trainer, advisor, or collaborator first. Their access starts empty.'),actions(button('Invite collaborator',inviteForm,{primary:true}),button('Cancel',closeEditor))]);return;}
    const account=select(collaborators.map(m=>[m.id,`${m.name}${m.status==='invited'?' · invited':''}`]),collaborators[0].id);
    const label=textInput('','text',{required:true,maxlength:120,placeholder:'e.g. Training and weekly progress'}),expires=expiryInput();
    const eligible=state.records;
    const selected=chooseMany(eligible.map(r=>[r.id,`${KIND_NAMES[r.kind] || r.kind} · ${r.title} · ${subjectName(r.subjectId)}`]));
    const future=check('Also include future records',false,'New records must match both the selected people and types below. This includes matching personal records you create, even when they are not shared with family.');
    const subjects=chooseMany([['self','My personal / adult records'],...state.children.filter(c=>(c.guardianIds || []).includes(state.me.id)).map(c=>[c.id,c.name])]);
    const kinds=chooseMany(KINDS.map(k=>[k,KIND_NAMES[k]]));
    const futureArea=el('div',{class:'family-grid',hidden:true},[el('fieldset',{class:'family-fieldset'},[el('legend',{text:'People in this scope'}),subjects.node]),el('fieldset',{class:'family-fieldset'},[el('legend',{text:'Record types in this scope'}),kinds.node])]);future.input.addEventListener('change',()=>{futureArea.hidden=!(future.input.checked || tasks.input.checked || uploads.input.checked);});
    const view=check('View selected records',true),tasks=check('Submit tasks',false,'New tasks go to your Incoming inbox for review.'),uploads=check('Submit documents',false,'Documents go to your Incoming inbox for review.');
    const direct=check('Create tasks directly',false,'Trusted access: tasks are assigned to you without an approval step.');direct.input.disabled=true;tasks.input.addEventListener('change',()=>{direct.input.disabled=!tasks.input.checked;if(!tasks.input.checked)direct.input.checked=false;futureArea.hidden=!(future.input.checked || tasks.input.checked || uploads.input.checked);});uploads.input.addEventListener('change',()=>{futureArea.hidden=!(future.input.checked || tasks.input.checked || uploads.input.checked);});
    openEditor('Create access',[form([
      el('div',{class:'family-grid'},[field('For',account),field('Access label',label)]),field('Access expires',expires),
      el('fieldset',{class:'family-fieldset'},[el('legend',{text:'Choose existing records'}),eligible.length?selected.node:note('No shareable records yet. You can explicitly choose a future scope below.')]),future.node,futureArea,
      el('fieldset',{class:'family-fieldset'},[el('legend',{text:'What they can do'}),view.node,tasks.node,uploads.node,direct.node]),
      note('This access never allows editing or deleting existing records. You can preview exactly what is shared after creating it.'),
    ],()=>{
      if(!selected.values().length && !future.input.checked && !tasks.input.checked && !uploads.input.checked){say('Choose records, or enable and define a future scope.',true);return;}
      if((future.input.checked || tasks.input.checked || uploads.input.checked) && (!subjects.values().length || !kinds.values().length)){say('Choose at least one person and record type for future records or submissions.',true);return;}
      if(tasks.input.checked && !kinds.values().includes('task') || uploads.input.checked && !kinds.values().includes('document')){say('Include Task or Document in the allowed record types for the submission permissions you selected.',true);return;}
      if(view.input.checked && !selected.values().length && !future.input.checked){say('Choose existing records to view or include matching future records. You can turn off View for submission-only access.',true);return;}
      if(future.input.checked && !view.input.checked){say('Enable View selected records to include future records.',true);return;}
      if(!view.input.checked && !tasks.input.checked && !uploads.input.checked){say('Choose at least one permission.',true);return;}
      mutate('grant.create',{accountId:account.value,label:label.value,recordIds:selected.values(),subjectIds:(future.input.checked || tasks.input.checked || uploads.input.checked)?subjects.values():[],kinds:(future.input.checked || tasks.input.checked || uploads.input.checked)?kinds.values():[],includeFuture:future.input.checked,permissions:{view:view.input.checked,submitTasks:tasks.input.checked,uploadDocuments:uploads.input.checked,directTasks:tasks.input.checked && direct.input.checked},expiresAt:expiryValue(expires)},{success:'Access created. Use Preview to inspect the recipient’s view.'});
    },'Create access')]);
  }
  function credentialForm(grant){const label=textInput('','text',{required:true,maxlength:120,placeholder:'e.g. Trainer integration'}),expires=expiryInput();
    if(grant.expiresAt){expires.max=grant.expiresAt.slice(0,10);if(expires.value>expires.max)expires.value=expires.max;}
    openEditor('Create an API key',[form([field('Key label',label),field('Key expires',expires),note(`This key has only the permissions in “${grant.label}”. Copy it now and give it only to the intended integration. People sign in to the portal with a password and authenticator instead.`)],()=>perform(async()=>{
      const result=await request('credential.create',{grantId:grant.id,label:label.value,expiresAt:new Date(Math.min(new Date(expiryValue(expires)).getTime(),new Date(grant.expiresAt).getTime())).toISOString()});
      revealed={title:'Scoped API key',value:result.token,description:'Copy this key now. It will not be shown again. Use Authorization: Bearer <key> with the collaboration API.'};return result;
    },{success:'API key created.'}),'Create key')]);
  }
  function submissionGrants(permission){return state.grants.filter(g=>familyGrantActive(g) && g.permissions?.[permission]);}
  function grantFields(permission){
    const grants=submissionGrants(permission);const grant=select(grants.map(g=>[g.id,g.label || 'Shared access']),grants[0]?.id);
    const subject=select([]);const update=()=>{const ids=familySubmissionSubjects(grants.find(g=>g.id===grant.value),state.records);subject.replaceChildren(...ids.map(id=>el('option',{value:id==='self'?'':id,text:id==='self'?'Recipient’s personal / adult records':subjectName(id)})));};grant.addEventListener('change',update);update();
    return {grants,grant,subject,nodes:[field('Access',grant),field('About',subject)]};
  }
  function submitTaskForm(){const scope=grantFields('submitTasks');if(!scope.grants.length){say('You do not currently have permission to submit tasks.',true);return;}
    const title=textInput('','text',{required:true,maxlength:200}),details=el('textarea',{class:'family-input',rows:4,maxlength:20000}),date=textInput('','date'),idempotencyKey=uid();
    const treatment=note('');const update=()=>{treatment.textContent=scope.grants.find(g=>g.id===scope.grant.value)?.permissions?.directTasks?'This access creates the task directly for the person who granted access.':'The person who granted access will review this task in Incoming.';};scope.grant.addEventListener('change',update);update();
    openEditor('Submit a task',[form([field('Title',title),field('Details',details),field('Proposed date',date),el('div',{class:'family-grid'},scope.nodes),treatment],()=>mutate('task.submit',{title:title.value,details:details.value,date:date.value,subjectId:scope.subject.value,grantId:scope.grant.value,idempotencyKey},{success:result=>result?.record?'Task created.':'Task sent for review.'}),'Submit task')]);
  }
  function uploadForm(){const isParent=parent(),scope=isParent?null:grantFields('uploadDocuments');if(!isParent && !scope.grants.length){say('You do not currently have permission to submit documents.',true);return;}
    const file=textInput('','file',{required:true,accept:'.pdf,.png,.jpg,.jpeg,.txt'}),title=textInput('','text',{maxlength:200}),details=el('textarea',{class:'family-input',rows:3,maxlength:20000});
    const subject=isParent?select(subjectOptions()):scope.subject,visibility=select([['private','Only me'],['family','Shared with family']],'private'),idempotencyKey=uid();
    openEditor(isParent?'Add a document':'Submit a document',[form([field('File',file,'PDF, PNG, JPEG, or TXT · Up to 8 MB'),field('Title (optional)',title),field('Details (optional)',details),isParent?el('div',{class:'family-grid'},[field('About',subject),field('Visibility',visibility)]):el('div',{class:'family-grid'},scope.nodes),note(isParent?'The file becomes a family workspace record with the visibility you choose.':'The recipient will review your file before accepting it. Uploading does not automatically import its contents.')],()=>{
      const picked=file.files?.[0];if(!picked){say('Choose a file.',true);return;}if(picked.size>8*1024*1024){say('Choose a document smaller than 8 MB.',true);return;}
      perform(async()=>request('document.upload',{filename:picked.name,base64:await fileBase64(picked),...(title.value.trim()?{title:title.value}:{}),details:details.value,subjectId:subject.value,...(isParent?{visibility:visibility.value}:{grantId:scope.grant.value}),idempotencyKey}),{success:isParent?'Document added.':'Document sent for review.'});
    },isParent?'Add document':'Submit document')]);
  }
  function reviewSubmission(submission){const content=submission.payload || submission.input || submission;const title=textInput(content.title || submission.title || content.filename || '','text',{required:true,maxlength:200}),details=el('textarea',{class:'family-input',rows:4,maxlength:20000,text:content.details || ''}),date=textInput(content.date,'date'),visibility=select([['private','Only me'],['family','Shared with family']],'private');
    openEditor('Review submission',[submission.kind==='document' && actions(button('Download submitted document',()=>saveDownload(submission))),form([note(`From ${personName(submission.createdBy || submission.accountId || submission.submittedBy)} · ${dateLabel(submission.createdAt)}`),field('Title',title),field('Details',details),el('div',{class:'family-grid'},[field('Date',date),field('Save visibility',visibility)]),note('Accepting creates one record. Document contents can be reviewed for import separately.')],()=>mutate('submission.review',{id:submission.id,decision:'accept',title:title.value,details:details.value,date:date.value,visibility:visibility.value},{success:'Submission accepted.'}),'Accept submission'),actions(button('Decline submission',()=>mutate('submission.review',{id:submission.id,decision:'decline'},{success:'Submission declined.'}))) ]);
  }
  function snapshotForm(){if(!publishSources || !publishSnapshot)return;perform(async()=>{
    const data=await publishSources(),sources=list(data?.sources);const picker=select(sources.map(s=>[s.id,`${s.sourceLabel || KIND_NAMES[s.kind] || 'Snapshot'} · ${s.title}`]),sources[0]?.id),subject=select(subjectOptions()),visibility=select([['private','Only me'],['family','Shared with family']],'private');
    const excerpt=el('div',{class:'family-excerpt'});const update=()=>{const source=sources.find(s=>s.id===picker.value);excerpt.replaceChildren(...(source?[el('strong',{text:source.title}),note(source.details || 'No additional details.'),source.date && note(dateLabel(source.date))]:[note('No source records are available to publish.')]));};picker.addEventListener('change',update);update();
    openEditor('Publish a snapshot',[note('Choose one existing Zelos item to copy into this workspace. Review its contents before sharing. This is a dated snapshot; later changes to the original are not synced.'),sources.length?form([field('Source item',picker),excerpt,el('div',{class:'family-grid'},[field('About',subject),field('Visibility',visibility)])],()=>perform(()=>publishSnapshot({sourceId:picker.value,subjectId:subject.value,visibility:visibility.value,fingerprint:sources.find(source=>source.id===picker.value)?.fingerprint}),{success:'Snapshot created. You can now include it in scoped access.'}),'Create snapshot'):actions(button('Close',closeEditor))]);
  },{reload:false,close:false});}
  async function saveDownload(record){if(!download)return;say('');await perform(async()=>{const result=await download(record.id);if(!result || !(result.blob instanceof Blob))throw new Error('The document could not be downloaded.');const url=URL.createObjectURL(result.blob),link=el('a',{href:url,download:result.filename || record.filename || 'document'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);},{reload:false,close:false,success:'Download started.'});}
  function recordCard(record,{readOnly=false}={}) {
    const context=readOnly && preview?preview:state;
    const meta=[KIND_NAMES[record.kind] || record.kind,record.subjectId?subjectName(record.subjectId,context):null,record.date?dateLabel(record.date):null,record.assigneeId?`Assigned to ${personName(record.assigneeId,context)}`:null].filter(Boolean).join(' · ');
    const controls=[];
    if(record.kind==='document' && download && !readOnly)controls.push(button('Download',()=>saveDownload(record)));
    if(record.kind==='document' && reviewDocument && !readOnly)controls.push(button('Review for import',()=>perform(()=>reviewDocument(record),{reload:false,close:false})));
    if(!readOnly && editable(record)){
      controls.push(button('Edit',()=>recordForm(record)));
      if(record.kind==='task')controls.push(button(record.status==='done'?'Reopen':'Mark done',()=>mutate('record.save',{id:record.id,version:record.version,kind:record.kind,title:record.title,details:record.details || '',date:record.date || '',subjectId:record.subjectId || '',assigneeId:record.assigneeId || '',visibility:record.visibility,status:record.status==='done'?'open':'done'},{success:record.status==='done'?'Task reopened.':'Task completed.',close:false})));
      controls.push(button('Delete',()=>confirmAction('Delete record',`Delete “${record.title}” from the family workspace?`,'record.delete',{id:record.id,version:record.version})));
    }
    return el('article',{class:`family-record ${record.status==='done'?'is-done':''}`},[
      el('div',{class:'family-row-head'},[el('div',{},[el('h3',{text:record.title || 'Untitled record'}),note(meta)]),el('div',{class:'family-badges'},[record.visibility && badge(record.visibility==='private'?(readOnly || !parent()?'Shared with you':'Personal'):'Family'),record.status==='done' && badge('Done')])]),
      record.details && el('p',{class:'family-record-details',text:record.details}),record.source && note(`Snapshot · ${typeof record.source==='string'?record.source:record.source.label || 'Published source'}`),
      record.filename && note(`${record.filename}${record.size?` · ${(record.size/1024).toFixed(0)} KB`:''}`),
      record.createdBy && record.createdBy!==context.me.id && note(`Created by ${personName(record.createdBy,context)}`),controls.length && actions(...controls),
    ]);
  }
  function familyView(){
    const records=state.records,open=records.filter(r=>r.kind==='task' && r.status!=='done'),plans=records.filter(r=>r.kind==='plan' || r.kind==='event');
    const count=(value,label)=>el('div',{class:'family-stat'},[el('strong',{text:value}),el('span',{text:label})]);
    const children=section('Children',[
      state.children.length?el('div',{class:'family-children'},state.children.map(child=>el('article',{class:'family-child'},[
        el('div',{class:'family-avatar','aria-hidden':'true',text:String(child.name || '?').trim().slice(0,1).toUpperCase()}),el('div',{class:'family-child-info'},[el('h3',{text:child.name}),note(child.birthday?`Birthday ${dateLabel(child.birthday)}`:'A profile you can plan for'),note(`Managed by ${(child.guardianIds || []).map(id=>personName(id)).join(', ') || 'designated parents'}`),child.notes && note(child.notes),actions(button('View records',()=>{filterSubject=child.id;tab='records';paint();}),parent() && (child.guardianIds || []).includes(state.me.id) && button('Edit profile',()=>childForm(child)))])
      ]))):el('div',{class:'family-empty'},[el('h3',{text:'A place for their plans, too'}),note('Add a child profile to organize school dates, activities, goals, and progress. Each parent keeps a separate account.')]),
      parent() && actions(button('Add child',()=>childForm(),{primary:true})),
    ]);
    return [el('div',{class:'family-stats'},[count(members().length,'Parent accounts'),count(state.children.length,'Child profiles'),count(open.length,'Open tasks'),count(plans.length,'Plans & events')]),children,
      section('Your next steps',[...(open.slice(0,4).map(r=>recordCard(r))),!open.length && note('No open tasks. Create a task for yourself or assign one to a parent.'),parent() && actions(button('Create task',()=>recordForm({kind:'task'})),button('Plan something',()=>recordForm({kind:'plan'})))]),
      section('Family accounts',[...members().map(member=>el('div',{class:'family-member'},[el('div',{},[el('strong',{text:member.id===state.me.id?`${member.name} · You`:member.name}),note([member.role==='owner'?'Owner':'Parent',member.email,member.status==='invited'?'Invitation pending':null].filter(Boolean).join(' · '))]),state.me.role==='owner' && member.id!==state.me.id && member.role!=='owner' && button('Remove',()=>confirmAction('Remove parent',`Remove ${member.name} from this family and revoke their family sessions and derived access?`,'member.revoke',{id:member.id}))])),parent() && actions(button('Invite someone',inviteForm),button('Rename family',familySettings),button('Your name',accountSettings))], 'Joining this family does not expose an adult’s private records.'),
    ];
  }
  function recordsView(){
    const kind=select([['','All types'],...KINDS.map(k=>[k,KIND_NAMES[k]])],filterKind),subject=select([['','Everyone'],['self','Personal / adult'],...state.children.map(c=>[c.id,c.name])],filterSubject),search=textInput(filterText,'search',{placeholder:'Find a record','aria-label':'Find a record'});
    const results=el('div',{class:'family-record-list'});function update(){filterKind=kind.value;filterSubject=subject.value;filterText=search.value;const found=state.records.filter(r=>(!filterKind || r.kind===filterKind) && (!filterSubject || (filterSubject==='self'?!r.subjectId:r.subjectId===filterSubject)) && `${r.title} ${r.details || ''}`.toLocaleLowerCase().includes(filterText.toLocaleLowerCase()));results.replaceChildren(...(found.length?found.map(r=>recordCard(r)):[el('div',{class:'family-empty'},[el('h3',{text:'No records here yet'}),note(filterText || filterKind || filterSubject?'Try another filter or create a record.':'Tasks, plans, tracking, notes, and documents appear here when created or explicitly shared.')])]));}
    kind.addEventListener('change',update);subject.addEventListener('change',update);search.addEventListener('input',update);update();
    return [actions(parent() && button('Create record',()=>recordForm(),{primary:true}),parent() && button('Add document',uploadForm),!parent() && submissionGrants('submitTasks').length>0 && button('Submit task',submitTaskForm,{primary:true}),!parent() && submissionGrants('uploadDocuments').length>0 && button('Submit document',uploadForm),publishSources && publishSnapshot && button('Publish a snapshot',snapshotForm)),el('div',{class:'family-filters'},[field('Search',search),field('Type',kind),field('About',subject)]),state.pagination?.records?.hasMore && note('Showing the first 500 records available to your account.'),results];
  }
  function secretCard(){if(!revealed)return null;const input=el('textarea',{class:'family-input family-secret',rows:3,readOnly:true,'aria-label':revealed.title,text:revealed.value});input.addEventListener('focus',()=>input.select());return section(revealed.title,[note(revealed.description),input,actions(button('Copy',async()=>{say(await copyText(revealed.value)?'Copied.':'Select the text above and copy it manually.');}),button('I have copied it',()=>{revealed=null;paint();}))]);}
  function grantCard(grant){const active=familyGrantActive(grant),accepted=state.members.find(member=>member.id===grant.accountId)?.status!=='invited',p=grant.permissions || {},rights=[p.view?'View records':null,p.submitTasks?(p.directTasks?'Create tasks directly':'Submit tasks for review'):null,p.uploadDocuments?'Submit documents for review':null].filter(Boolean);
    return el('article',{class:'family-record'},[el('div',{class:'family-row-head'},[el('div',{},[el('h3',{text:grant.label || 'Shared access'}),note(`${parent()?personName(grant.accountId):(grant.grantorName || personName(grant.grantorId))} · ${active?'Expires':'Ended'} ${dateLabel(grant.expiresAt)}`)]),badge(active?'Active':'Inactive')]),note(rights.join(' · ') || 'No active permissions'),!accepted && note('Waiting for this person to accept their invitation. API keys become available after acceptance.'),note(`${(grant.recordIds || []).length} selected records${grant.includeFuture?' · Includes matching future records':''}`),
      parent() && actions(button('Preview access',()=>perform(async()=>{preview=normalizeFamilyState(await request('grant.preview',{id:grant.id}));},{reload:false,close:false})),active && accepted && button('Create API key',()=>credentialForm(grant)),active && button('Revoke access',()=>confirmAction('Revoke access',`Revoke “${grant.label}” and its API keys? Future requests stop immediately. Previously downloaded files cannot be recalled.`,'grant.revoke',{id:grant.id}))),
    ]);
  }
  function accessView(){
    const p=portal();const nodes=[];
    if(parent())nodes.push(section('Invite and connect',[note(p.published?'Your guest portal has a published address. Invitations still require their own secret link.':p.ready?(mode==='guest'?'You are using the guest portal. Share invitations only with people who can reach this address.':'Local preview · Your guest portal is running locally. It has not been published for remote access.'):'The guest portal is not running. Saved invitations and access will need a reachable portal to be used.'),p.ready && p.url && el('a',{class:'family-button',href:p.url,target:'_blank',rel:'noopener noreferrer',text:p.published || mode==='guest'?'Open guest portal':'Open local guest preview'}),actions(button('Invite someone',inviteForm,{primary:true}),button('Create access',grantForm))], 'Separate parent accounts. Specific access for trainers, advisors, and other people you trust.'));
    nodes.push(el('details',{class:'family-panel'},[el('summary',{text:'How sharing is protected'}),note('People join by invitation using their own account, password, and authenticator. You choose the records they can see and the actions they can take.'),note('Access expires and can be revoked. Tasks submitted by collaborators wait for your review unless you explicitly allow direct task creation.'),note('Published source snapshots are copies. Revoking access stops future requests, but cannot recall copies someone has already downloaded.')]));
    nodes.push(section(parent()?'Scoped access':'Your shared access',state.grants.length?state.grants.map(grantCard):[el('div',{class:'family-empty'},[el('h3',{text:parent()?'Start with a person and a purpose':'Nothing has been shared yet'}),note(parent()?'Invite a collaborator, choose what they can see, and decide whether they can submit tasks or documents.':'Ask the person who invited you to add the records and permissions you need.')])]));
    if(parent() && state.members.some(m=>m.role==='collaborator'))nodes.push(section('Collaborators',state.members.filter(m=>m.role==='collaborator').map(member=>el('div',{class:'family-member'},[el('div',{},[el('strong',{text:member.name}),note([member.email,member.status].filter(Boolean).join(' · '))]),member.status!=='revoked' && button('Remove',()=>confirmAction('Remove collaborator',`Remove ${member.name} and revoke the access you created for them?`,'member.revoke',{id:member.id}))]))));
    if(parent() && state.invitations.length)nodes.push(section('Invitations',state.invitations.map(inv=>el('div',{class:'family-member'},[el('div',{},[el('strong',{text:inv.name || inv.email || 'Invitation'}),note(`${inv.role} · ${inv.status || (inv.usedAt?'Accepted':inv.revokedAt?'Revoked':new Date(inv.expiresAt).getTime()<Date.now()?'Expired':'Pending')} · Expires ${dateLabel(inv.expiresAt)}`)]),inv.email && note(inv.email)]))));
    if(parent() && state.credentials.length)nodes.push(section('API keys',state.credentials.map(key=>el('div',{class:'family-member'},[el('div',{},[el('strong',{text:key.label || 'API key'}),note(`${key.revokedAt?'Revoked':`Expires ${dateLabel(key.expiresAt)}`} · ${key.lastUsedAt?`Last used ${dateLabel(key.lastUsedAt)}`:`Created ${dateLabel(key.createdAt)}`}`)]),!key.revokedAt && button('Revoke key',()=>confirmAction('Revoke key',`Stop requests using “${key.label || 'this key'}”?`,'credential.revoke',{id:key.id}))]))));
    if(parent())nodes.push(el('details',{class:'family-panel'},[el('summary',{text:'API connection details'}),note('Create a scoped key on an access grant above. Every API request must include Authorization: Bearer <key>.'),p.ready && p.url && el('pre',{class:'family-code',text:`Base URL: ${p.url.replace(/\/$/,'')}/collaboration/v1\nGET  /me\nGET  /records\nPOST /tasks\nPOST /documents\nGET  /documents/{id}/download`}),note('Task body: title, optional details/date/subjectId, and a unique idempotencyKey. Document body: filename, base64, optional title/details/subjectId, and a unique idempotencyKey. Grant scope controls the allowed people and actions.'),!p.published && note(mode==='guest'?'Remote integrations must be able to reach this portal over HTTPS.':'This address is a local preview. Remote integrations need a published HTTPS portal.') ]));
    return nodes;
  }
  function incomingView(){const pending=state.submissions.filter(s=>s.status==='pending'),history=state.submissions.filter(s=>s.status!=='pending');
    const row=submission=>{const item=submission.payload || submission.input || submission;return el('article',{class:'family-record'},[el('div',{class:'family-row-head'},[el('div',{},[el('h3',{text:item.title || submission.title || item.filename || 'Submission'}),note(`${KIND_NAMES[submission.kind] || submission.kind || 'Submission'} · ${dateLabel(submission.createdAt)}`)]),badge(submission.status || 'Pending')]),item.details && el('p',{class:'family-record-details',text:item.details}),item.filename && note(item.filename),submission.kind==='document' && submission.status!=='declined' && download && actions(button('Download document',()=>saveDownload(submission))),note(`From ${personName(submission.createdBy || submission.accountId || submission.submittedBy)}`),parent() && submission.status==='pending' && actions(button('Review',()=>reviewSubmission(submission),{primary:true}),button('Decline',()=>mutate('submission.review',{id:submission.id,decision:'decline'},{success:'Submission declined.',close:false}))) ]);};
    return [section(parent()?'Ready for your review':'Your submissions',pending.length?pending.map(row):[el('div',{class:'family-empty'},[el('h3',{text:parent()?'You’re all caught up':'No pending submissions'}),note(parent()?'Tasks and documents sent for your approval appear here. Trusted direct tasks appear immediately in Records.':'Tasks and documents you submit for approval appear here.')])]),history.length && section('Reviewed',history.map(row))];
  }
  function previewPanel(){if(!preview)return null;return section('Preview · What this access reveals',[
    note('This preview is returned by the same permission checks used by the recipient’s API key.'),
    preview.records.length?el('div',{class:'family-record-list'},preview.records.map(r=>recordCard(r,{readOnly:true}))):note('No records are visible through this access.'),
    preview.children.length && note(`Visible child profiles: ${preview.children.map(c=>c.name).join(', ')}`),actions(button('Close preview',()=>{preview=null;paint();})),
  ]);}
  function paint(){if(destroyed)return;
    root.replaceChildren(messageNode,body);say(message,messageError);
    if(!state){body.replaceChildren(...[el('header',{class:'family-heading'},[el('h1',{text:'Family'}),note(messageError?'Your workspace could not be loaded.':'Loading your family workspace…')]),messageError && button('Try again',refresh)].filter(Boolean));return;}
    const isParent=parent();if(!isParent && tab==='family')tab='records';
    const tabs=isParent?[['family','Family'],['records','Records'],['access','Access'],['incoming',`Incoming${state.submissions.filter(s=>s.status==='pending').length?` · ${state.submissions.filter(s=>s.status==='pending').length}`:''}`]]:[['records','Shared records'],['incoming','Submissions'],['access','Access']];
    const nav=el('nav',{class:'family-tabs','aria-label':'Family workspace'},tabs.map(([id,label])=>{const b=button(label,()=>{tab=id;editor=null;preview=null;paint();});b.classList.toggle('is-active',tab===id);if(tab===id)b.setAttribute('aria-current','page');return b;}));
    const children=[el('header',{class:'family-heading'},[el('div',{},[el('p',{class:'family-eyebrow',text:mode==='owner'?'YOUR PEOPLE, IN ONE PLACE':'ZELOS · FAMILY & COLLABORATION'}),el('h1',{text:state.family.name || 'Family'}),note(isParent?'Plan together. Keep personal things personal.':`Welcome, ${state.me.name || 'collaborator'}. These are the records shared with you.`)]),button('Refresh',refresh)]),nav,
      isParent && el('div',{class:'family-privacy'},[el('strong',{text:'Private by default.'}),el('span',{text:' Your personal records stay yours. Family records and outside access are choices you make.'})]),
      secretCard(),previewPanel(),editor,...(tab==='family'?familyView():tab==='records'?recordsView():tab==='access'?accessView():incomingView())];
    body.replaceChildren(...children.filter(Boolean));
  }
  paint();refresh();
  return {refresh,destroy(){destroyed=true;revealed=null;state=null;editor=null;preview=null;root.replaceChildren();},getState(){return state;}};
}
