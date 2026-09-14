import {mountFamily} from '/family-client.js';

const SESSION_KEY='zelos.family.session';
const root=document.getElementById('family-root'),account=document.getElementById('account');
let session='',workspace=null,authBusy=false,authVersion=0,authController=null,expiryTimer=null,pendingAuth=null,pendingVerified=null,abandonedInvite=false;
try{session=sessionStorage.getItem(SESSION_KEY) || '';}catch{}
const fragment=new URLSearchParams(window.location.hash.slice(1));
let invite=fragment.get('invite') || '';
fragment.delete('invite');
if(window.location.hash)window.history.replaceState(null,'',window.location.pathname+window.location.search);

function node(tag,attrs={},children=[]){
  const n=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){
    if(key==='text')n.textContent=value;
    else if(key==='class')n.className=value;
    else if(value!==false && value!==undefined)n.setAttribute(key,String(value));
  }
  for(const child of children.filter(Boolean))n.append(child);
  return n;
}
const note=text=>node('p',{class:'family-note',text});
function field(label,input,hint=''){return node('label',{class:'family-field'},[node('span',{text:label}),input,hint && note(hint)]);}
function button(label,fn,primary=false){const b=node('button',{class:`family-button${primary?' is-primary':''}`,type:'button',text:label});b.addEventListener('click',fn);return b;}
function saveSession(token){session=token;try{if(token)sessionStorage.setItem(SESSION_KEY,token);else sessionStorage.removeItem(SESSION_KEY);}catch{}}
function clearDisplayedSecrets(){
  for(const input of root.querySelectorAll('[data-auth-secret]')){input.value='';input.textContent='';}
}
function clearTransient(){
  authVersion++;authController?.abort();authController=null;authBusy=false;
  clearTimeout(expiryTimer);expiryTimer=null;clearDisplayedSecrets();
  if(pendingAuth){pendingAuth.challenge='';if(pendingAuth.enrollment){pendingAuth.enrollment.secret='';pendingAuth.enrollment.otpAuthUri='';}}
  if(pendingVerified){pendingVerified.token='';pendingVerified.recoveryCodes?.fill('');}
  pendingAuth=null;pendingVerified=null;
}
function stopWorkspace(){workspace?.destroy();workspace=null;}
async function api(path,{method='GET',body,authenticated=true,token=session,signal}={}){
  const response=await fetch(path,{method,credentials:'omit',cache:'no-store',signal,
    headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(authenticated?{Authorization:`Bearer ${token}`}:{})},
    body:body?JSON.stringify(body):undefined});
  let data;try{data=await response.json();}catch{data={};}
  if(!response.ok){const error=new Error(typeof data.error==='string'?data.error:'The request could not be completed.');error.status=response.status;throw error;}
  return data;
}
async function workspaceApi(path,options){
  try{return await api(path,options);}
  catch(error){if(error.status===401){saveSession('');stopWorkspace();invite='';showAuth('Your session ended. Sign in again.');}throw error;}
}
function shell(title,description,content){
  account.replaceChildren(node('span',{text:'Family & collaboration'}));root.className='';root.removeAttribute('aria-busy');
  root.replaceChildren(node('section',{class:'family-auth'},[
    node('p',{class:'family-eyebrow',text:'YOUR ACCOUNT. YOUR ACCESS.'}),node('h1',{text:title}),note(description),...content,
    note('Invitation-only access · Your named account shows only the records and permissions shared with you.'),
  ]));
}
function alertBox(message=''){const box=node('p',{class:'family-status is-error',role:'alert',text:message});box.hidden=!message;return box;}
function showError(box,message){box.textContent=message;box.hidden=false;}
function clearPasswords(...inputs){for(const input of inputs){input.value='';input.textContent='';}}
function showAuth(message=''){
  clearTransient();const viewVersion=authVersion,accepting=Boolean(invite);
  const error=alertBox(message);
  const email=node('input',{class:'family-input',type:'email',required:true,autocomplete:'username',maxlength:254});
  const password=node('input',{class:'family-input',type:'password',required:true,minlength:accepting?12:1,maxlength:128,autocomplete:accepting?'new-password':'current-password','data-auth-secret':true});
  const again=node('input',{class:'family-input',type:'password',required:true,minlength:12,maxlength:128,autocomplete:'new-password','data-auth-secret':true});
  const previous=node('input',{class:'family-input',type:'password',maxlength:128,autocomplete:'current-password','data-auth-secret':true});
  const submit=node('button',{class:'family-button is-primary',type:'submit',text:accepting?'Continue to account security':'Continue'});
  const form=node('form',{class:'family-form'},[
    !accepting && field('Email',email),
    field(accepting?'Create a password':'Password',password,accepting?'Use 12–128 characters. Each parent or collaborator has a separate account.':''),
    accepting && field('Confirm password',again),
    accepting && field('Previous password, if reconnecting an existing account',previous,'An existing account also needs its previous authenticator or a recovery code in the next step.'),
    submit,
  ]);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(authBusy || !form.reportValidity() || viewVersion!==authVersion)return;
    if(accepting && password.value!==again.value){showError(error,'The passwords do not match.');return;}
    authBusy=true;submit.disabled=true;submit.textContent='Checking…';error.hidden=true;
    authController=new AbortController();
    try{
      const result=await api(accepting?'/family/v1/accept':'/family/v1/login',{method:'POST',authenticated:false,signal:authController.signal,
        body:accepting?{token:invite,password:password.value,...(previous.value?{currentPassword:previous.value}:{})}:{email:email.value,password:password.value}});
      if(viewVersion!==authVersion)return;
      clearPasswords(password,again,previous);
      if(!isChallenge(result)){if(result?.token)void revokeToken(result.token);throw new Error('This portal must support authenticator verification before you can sign in.');}
      invite='';showChallenge(result,accepting?'invite':'login');
    }catch(errorValue){if(viewVersion===authVersion && errorValue.name!=='AbortError'){clearPasswords(password,again,previous);showError(error,errorValue.message);}}
    finally{if(viewVersion===authVersion){authBusy=false;authController=null;submit.disabled=false;submit.textContent=accepting?'Continue to account security':'Continue';}}
  });
  shell(accepting?'You’re invited.':'Welcome back.',accepting?'Create your password, then protect your account with an authenticator app.':'Sign in with your password and your authenticator app.',[
    error,form,accepting && node('div',{class:'family-actions'},[button('Use an existing account',()=>{invite='';showAuth();})]),
    note('A password and a time-based authenticator code are required for invited accounts. Server integrations use separately scoped API keys.'),
  ]);
  (accepting?password:email).focus();
}
function isChallenge(value){return value?.mfaRequired===true && typeof value.challenge==='string' && value.challenge.length>0 && Number.isFinite(Date.parse(value.expiresAt));}
function challengeExpired(origin,message='This verification step expired.'){invite='';showAuth(`${message} ${origin==='invite'?'Reopen your invitation link to start again.':'Sign in again to start a new step.'}`);}
function scheduleExpiry(expiresAt,callback){clearTimeout(expiryTimer);expiryTimer=setTimeout(callback,Math.max(0,Date.parse(expiresAt)-Date.now()));}
async function copySecret(value,status){
  if(!value)return;
  try{await navigator.clipboard.writeText(value);status.textContent='Copied.';}
  catch{status.textContent='Select the text above and copy it manually.';}
}
function showChallenge(result,origin){
  const challenge={...result,enrollment:result.enrollment?{...result.enrollment}:undefined,origin};
  clearTransient();pendingAuth=challenge;const viewVersion=authVersion;
  if(Date.parse(challenge.expiresAt)<=Date.now()){challengeExpired(origin);return;}
  const enrollment=Boolean(challenge.enrollment);
  if(enrollment && (typeof challenge.enrollment.secret!=='string' || !challenge.enrollment.secret)){challengeExpired(origin,'The authenticator setup could not be loaded.');return;}
  const error=alertBox(),copyStatus=node('p',{class:'family-note',role:'status','aria-live':'polite'});
  const code=node('input',{class:'family-input family-auth-code',type:'text',required:true,inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]{6}',maxlength:6,'data-auth-secret':true});
  const codeField=field('Authenticator code',code,'Enter the current six-digit code from your authenticator app.');
  let recoveryMode=false;
  const toggle=button('Use a recovery code',()=>{
    if(authBusy || viewVersion!==authVersion)return;
    recoveryMode=!recoveryMode;code.value='';codeField.children[0].textContent=recoveryMode?'Recovery code':'Authenticator code';
    codeField.children[2].textContent=recoveryMode?'Enter one unused recovery code saved when you set up your account.':'Enter the current six-digit code from your authenticator app.';
    code.setAttribute('inputmode',recoveryMode?'text':'numeric');code.setAttribute('autocomplete',recoveryMode?'off':'one-time-code');code.setAttribute('maxlength',recoveryMode?26:6);
    code.setAttribute('pattern',recoveryMode?'zfr_[A-Za-z0-9_-]{22}':'[0-9]{6}');code.setAttribute('autocapitalize','none');code.setAttribute('spellcheck','false');
    toggle.textContent=recoveryMode?'Use my authenticator app':'Use a recovery code';error.hidden=true;code.focus();
  });
  const submit=node('button',{class:'family-button is-primary',type:'submit',text:enrollment?'Verify authenticator':'Verify and continue'});
  const form=node('form',{class:'family-form'},[codeField,submit]);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(authBusy || viewVersion!==authVersion || !form.reportValidity())return;
    const value=code.value.trim();
    if(!(recoveryMode?/^zfr_[A-Za-z0-9_-]{22}$/:/^\d{6}$/).test(value)){showError(error,recoveryMode?'Enter a complete recovery code.':'Enter a six-digit authenticator code.');return;}
    if(Date.parse(pendingAuth.expiresAt)<=Date.now()){challengeExpired(origin);return;}
    authBusy=true;submit.disabled=true;toggle.disabled=true;submit.textContent='Verifying…';error.hidden=true;authController=new AbortController();
    try{
      const verified=await api('/family/v1/verify',{method:'POST',authenticated:false,signal:authController.signal,body:{challenge:pendingAuth.challenge,code:value}});
      if(viewVersion!==authVersion){if(verified?.token)void revokeToken(verified.token);return;}
      code.value='';
      if(isChallenge(verified)){showChallenge(verified,origin);return;}
      if(typeof verified?.token!=='string' || !verified.token || !verified.account)throw new Error('Verification did not return an account session. Sign in again.');
      if(Array.isArray(verified.recoveryCodes) && verified.recoveryCodes.length)showRecoveryCodes(verified);
      else await finishSignIn(verified);
    }catch(errorValue){
      if(viewVersion!==authVersion || errorValue.name==='AbortError')return;
      code.value='';
      if(errorValue.status===429 || /expired/i.test(errorValue.message) || Date.parse(pendingAuth.expiresAt)<=Date.now())challengeExpired(origin,errorValue.message);
      else showError(error,errorValue.message);
    }finally{if(viewVersion===authVersion){authBusy=false;authController=null;submit.disabled=false;toggle.disabled=false;submit.textContent=enrollment?'Verify authenticator':'Verify and continue';}}
  });
  const setup=[];
  if(enrollment){
    const key=node('textarea',{class:'family-input family-secret family-setup-key',rows:2,readonly:true,'aria-label':'Authenticator setup key','data-auth-secret':true,text:challenge.enrollment.secret});
    key.addEventListener('focus',()=>key.select());
    setup.push(node('div',{class:'family-auth-setup'},[
      node('h2',{text:'Add Zelos to your authenticator'}),note('Choose “Enter a setup key” or “Add account manually” in your authenticator app. Name the account Zelos, paste the key below, and select Time-based (TOTP).'),
      field('Setup key',key),node('div',{class:'family-actions'},[button('Copy setup key',()=>copySecret(pendingAuth?.enrollment?.secret,copyStatus))]),copyStatus,
      note('Keep this setup key private. Zelos shows it directly; it is never sent to a QR-code service.'),
    ]));
  }
  shell(enrollment?'Set up your authenticator.':'Confirm it’s you.',enrollment?'An authenticator app adds a second check before anyone can open your account.':'Use your authenticator app to finish signing in.',[
    ...setup,error,form,!enrollment && node('div',{class:'family-actions'},[toggle]),
    note('This step expires after five minutes and allows up to five attempts.'),
    node('div',{class:'family-actions'},[button(enrollment?'Cancel setup':'Cancel sign-in',()=>{invite='';showAuth(origin==='invite'?'Setup canceled. Reopen your invitation link when you are ready.':'Sign-in canceled.');})]),
    enrollment && note('If you arrived here using a recovery code, this replaces your previous authenticator. No account session opens until you verify the new setup.'),
  ]);
  scheduleExpiry(challenge.expiresAt,()=>{if(viewVersion===authVersion)challengeExpired(origin);});code.focus();
}
async function revokeToken(token){try{await api('/family/v1/logout',{method:'POST',body:{},token});}catch{}}
function showRecoveryCodes(result){
  const verified={token:result.token,account:result.account,recoveryCodes:[...result.recoveryCodes]};
  clearTransient();pendingVerified=verified;const viewVersion=authVersion;
  const codes=node('textarea',{class:'family-input family-secret family-recovery-codes',rows:8,readonly:true,'aria-label':'Recovery codes','data-auth-secret':true,text:verified.recoveryCodes.join('\n')});
  codes.addEventListener('focus',()=>codes.select());
  const copied=node('p',{class:'family-note',role:'status','aria-live':'polite'});
  const saved=node('input',{type:'checkbox'});
  const go=button('Continue to my workspace',async()=>{if(!saved.checked || authBusy || viewVersion!==authVersion)return;go.disabled=true;await finishSignIn(pendingVerified);},true);go.disabled=true;
  saved.addEventListener('change',()=>{go.disabled=!saved.checked;});
  const cancel=(message='You’re signed out. Use your authenticator the next time you sign in.')=>{const token=pendingVerified?.token;invite='';showAuth(message);if(token)void revokeToken(token);};
  shell('Save your recovery codes.','These codes are shown once. Save them somewhere private, separate from your authenticator.',[
    codes,node('div',{class:'family-actions'},[
      button('Copy recovery codes',()=>copySecret(pendingVerified?.recoveryCodes.join('\n'),copied)),
      button('Download codes',()=>{
        if(!pendingVerified)return;const content=`Zelos recovery codes\n\nKeep these private. Each code can be used once to replace your authenticator.\n\n${pendingVerified.recoveryCodes.join('\n')}\n`;
        const url=URL.createObjectURL(new Blob([content],{type:'text/plain'})),link=node('a',{href:url,download:'zelos-recovery-codes.txt'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      }),
    ]),copied,
    node('label',{class:'family-check'},[saved,node('span',{text:'I have saved my recovery codes.'})]),
    go,note('Each code works once. Using one requires setting up and verifying a replacement authenticator.'),
    note('For your privacy, this page clears after five minutes.'),node('div',{class:'family-actions'},[button('Sign out',()=>cancel())]),
  ]);
  expiryTimer=setTimeout(()=>{if(viewVersion===authVersion)cancel('Recovery codes were cleared after five minutes. Sign in with your authenticator to continue.');},5*60000);
}
async function finishSignIn(result){
  const token=result?.token,me=result?.account;
  if(!token || !me)return;
  clearTransient();invite='';saveSession(token);
  try{await showWorkspace(me);}
  catch(error){saveSession('');stopWorkspace();void revokeToken(token);showAuth(error.message);}
}
async function authDownload(id){
  const response=await fetch(`/family/v1/documents/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${session}`},credentials:'omit',cache:'no-store'});
  if(!response.ok){let data;try{data=await response.json();}catch{}if(response.status===401){saveSession('');stopWorkspace();invite='';showAuth('Your session ended. Sign in again.');}throw new Error(data?.error || 'This document could not be downloaded.');}
  const disposition=response.headers.get('Content-Disposition') || '';const utf=disposition.match(/filename\*=UTF-8''([^;]+)/i),ordinary=disposition.match(/filename="([^"]+)"/i);let filename=ordinary?.[1] || 'document';if(utf){try{filename=decodeURIComponent(utf[1]);}catch{}}
  return {blob:await response.blob(),filename};
}
async function showWorkspace(knownAccount){
  const expectedSession=session;let me=knownAccount;if(!me){const state=await workspaceApi('/family/v1/state');me=state.me;}
  if(!session || session!==expectedSession)return;
  const logout=button('Sign out',async()=>{
    const token=session;saveSession('');stopWorkspace();invite='';showAuth('You’re signed out.');const version=authVersion;
    try{await api('/family/v1/logout',{method:'POST',body:{},token});}
    catch(error){if(version===authVersion)showAuth('Signed out on this device. The server could not confirm sign-out; that session will expire automatically.');}
  });
  account.replaceChildren(node('span',{text:me?.name || 'Your account'}),logout);
  stopWorkspace();workspace=mountFamily(root,{mode:'guest',portalUrl:window.location.origin,request:(action,input={})=>action?workspaceApi('/family/v1/action',{method:'POST',body:{action,input}}):workspaceApi('/family/v1/state'),download:authDownload});
}
export function disposeFamilyPortal(){
  const pendingToken=pendingVerified?.token;clearTransient();invite='';stopWorkspace();session='';root.replaceChildren();account.replaceChildren();if(pendingToken)void revokeToken(pendingToken);
}
window.addEventListener('pagehide',()=>{const token=pendingVerified?.token;abandonedInvite=Boolean(invite) || pendingAuth?.origin==='invite';clearTransient();invite='';if(token)void revokeToken(token);});
window.addEventListener('pageshow',event=>{
  if(!event.persisted)return;
  if(!session){showAuth(abandonedInvite?'Reopen your invitation link to continue setup.':'Sign in again to continue.');return;}
  stopWorkspace();root.replaceChildren(note('Checking your session…'));
  void showWorkspace().catch(error=>{saveSession('');showAuth(error.message);});
});
if(invite){saveSession('');showAuth();}else if(session)showWorkspace().catch(error=>{saveSession('');showAuth(error.message);});else showAuth();
