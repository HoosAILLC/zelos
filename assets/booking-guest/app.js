/** Guest-only browser code: no private app imports, cookies, or identity tokens. */
const PENDING='zelos.guest.pending.v1';
function node(tag,props={},children=[]){const element=document.createElement(tag);for(const [key,value]of Object.entries(props)){if(value===false||value==null)continue;if(key==='text')element.textContent=String(value);else if(key.startsWith('on'))element.addEventListener(key.slice(2).toLowerCase(),value);else element.setAttribute(key,value===true?'':String(value));}for(const child of [children].flat(Infinity)){if(child!==false&&child!=null)element.appendChild(typeof child==='string'?document.createTextNode(child):child);}return element;}
const button=(text,onClick,props={})=>node('button',{type:'button',text,onclick:onClick,...props});
const note=text=>node('p',{class:'note',text});
export function confirmationLink(origin,id,token){const url=new URL('/',origin);url.hash=new URLSearchParams({booking:id,token}).toString();return url.href;}
export function slotLabel(slot,timezone){return new Intl.DateTimeFormat(undefined,{timeZone:timezone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(slot.startsAt));}
async function request(route,body,{download=false}={}){
 let response;try{response=await fetch(`/guest/${route}`,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});}catch{const error=new Error('The connection stopped. If you confirmed a meeting, check the same request before booking again.');error.uncertain=route==='reserve';throw error;}
 if(!response.ok){let data;try{data=await response.json();}catch{}const error=new Error(data?.error||'This booking request could not be completed.');error.uncertain=!!data?.uncertain;error.notBooked=!!data?.notBooked;throw error;}
 return download?response.blob():response.json();
}
export function mountGuest(root,{api=request,storage=globalThis.sessionStorage,location=window.location,history=window.history}={}){
 const view={busy:false,error:'',notice:'',availability:null,slot:null,review:null,pending:null,confirmation:null,token:'',cancelReview:false,name:'',email:'',from:'',to:'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',uncertain:false};
 const remember=()=>{try{view.pending?storage.setItem(PENDING,JSON.stringify({payload:view.pending,review:view.review,sent:view.uncertain})):storage.removeItem(PENDING);}catch{}};
 function field(label,type,value,set){const input=node('input',{type,value,'aria-label':label,required:true,disabled:view.busy});input.addEventListener('input',()=>set(input.value));return node('label',{},[node('span',{text:label}),input]);}
 async function act(operation){if(view.busy)return;view.busy=true;view.error='';paint();try{await operation();}catch(error){view.error=error.message;if(error.uncertain)view.uncertain=true;if(error.notBooked){view.pending=null;view.review=null;view.uncertain=false;remember();}}finally{view.busy=false;paint();}}
 async function load(){await act(async()=>{view.availability=await api('availability',{...(view.from?{from:view.from}:{}),...(view.to?{to:view.to}:{})});view.from=view.availability.from;view.to=view.availability.to;});}
 async function review(){await act(async()=>{const result=await api('review',{startsAt:view.slot.startsAt,name:view.name,email:view.email});view.review=result;view.pending={nonce:result.nonce,name:result.contact.name,email:result.contact.email,startsAt:result.slot.startsAt};view.uncertain=false;remember();});}
 async function reserve(){await act(async()=>{view.uncertain=true;remember();const result=await api('reserve',view.pending);view.confirmation=result;view.token=result.cancellationToken;view.pending=null;view.review=null;view.uncertain=false;remember();history.replaceState(null,'',confirmationLink(location.origin,result.booking.id,view.token));});}
 async function cancel(){await act(async()=>{const result=await api('cancel',{id:view.confirmation.booking.id,token:view.token});view.confirmation={...view.confirmation,booking:result.booking};view.cancelReview=false;view.notice='Your meeting has been cancelled.';});}
 async function calendar(){await act(async()=>{const blob=await api('calendar',{id:view.confirmation.booking.id,token:view.token},{download:true});const url=URL.createObjectURL(blob),link=node('a',{href:url,download:'meeting.ics'});document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
 function edit(){view.review=null;view.pending=null;view.uncertain=false;remember();paint();}
 function availabilityPanel(){
  const available=view.availability;if(!available)return note(view.busy?'Checking available times…':'Available times could not be loaded.');
  if(!available.settings.enabled)return node('section',{class:'panel'},[node('h2',{text:'Booking is currently closed'}),note('Please contact the organizer directly.')]);
  const zones=[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',available.settings.timezone])];
  const zone=node('select',{'aria-label':'Display time zone'},zones.map(value=>node('option',{value,text:value.replaceAll('_',' ')})));zone.value=view.timezone;zone.addEventListener('change',()=>{view.timezone=zone.value;paint();});
  const filters=node('form',{class:'filters'},[field('From','date',view.from,value=>{view.from=value;}),field('Through','date',view.to,value=>{view.to=value;}),node('label',{},[node('span',{text:'Show times in'}),zone]),node('button',{type:'submit',text:'Find times',disabled:view.busy})]);filters.addEventListener('submit',event=>{event.preventDefault();view.slot=null;load();});
  return node('section',{class:'panel'},[node('h2',{text:'1. Choose a time'}),note(`${available.settings.durationMinutes} minute meeting. Times below use ${view.timezone.replaceAll('_',' ')}.`),filters,
   note(`The search dates use the organizer’s ${available.settings.timezone.replaceAll('_',' ')} calendar.`),
   node('div',{class:'slots'},available.slots.length?available.slots.map(slot=>button(slotLabel(slot,view.timezone),()=>{view.slot=slot;paint();},{class:view.slot?.startsAt===slot.startsAt?'slot selected':'slot','aria-pressed':view.slot?.startsAt===slot.startsAt,disabled:view.busy})):note('No times are available in this range. Try other dates.'))]);
 }
 function contactPanel(){const form=node('form',{class:'panel'},[node('h2',{text:'2. Your details'}),note(slotLabel(view.slot,view.timezone)),field('Name','text',view.name,value=>{view.name=value;}),field('Email','email',view.email,value=>{view.email=value;}),note('Your contact details will be visible to the organizer. No invitation email is sent by this page.'),node('button',{type:'submit',text:'Review meeting',disabled:view.busy})]);form.addEventListener('submit',event=>{event.preventDefault();review();});return form;}
 function reviewPanel(){const item=view.review;return node('section',{class:'panel'},[node('h2',{text:view.uncertain?'Check your confirmation':'3. Review before booking'}),
  item&&node('div',{class:'review-details'},[node('strong',{text:item.title}),note(slotLabel(item.slot,view.timezone)),note(`${item.contact.name} · ${item.contact.email}`)]),
  note(view.uncertain?'This request may already have been saved. Use the same request to recover its confirmation; do not reserve another time.':'The time will be checked again when you confirm. No invitation email will be sent.'),
  node('div',{class:'actions'},[button(view.uncertain?'Check same request':'Confirm booking',reserve,{disabled:view.busy}),!view.uncertain&&button('Edit details',edit,{class:'quiet',disabled:view.busy})])]);}
 function successPanel(){const result=view.confirmation,booking=result.booking;return node('section',{class:'panel success'},[
  node('h2',{text:booking.state==='cancelled'?'Meeting cancelled':'Your meeting is booked'}),node('strong',{text:result.title||'Meeting'}),note(slotLabel(booking,view.timezone)),
  note('No invitation email was sent. Keep your private confirmation link to manage this meeting.'),
  node('div',{class:'actions'},[booking.state==='confirmed'&&button('Add to calendar',calendar,{disabled:view.busy}),button('Copy confirmation link',()=>act(async()=>{await navigator.clipboard.writeText(confirmationLink(location.origin,booking.id,view.token));view.notice='Private confirmation link copied.';}),{class:'quiet',disabled:view.busy}),booking.state==='confirmed'&&!view.cancelReview&&button('Cancel meeting',()=>{view.cancelReview=true;paint();},{class:'quiet',disabled:view.busy})]),
  view.cancelReview&&node('div',{class:'cancel-check'},[note('Cancel this meeting? This will release the reserved time.'),node('div',{class:'actions'},[button('Yes, cancel meeting',cancel,{disabled:view.busy}),button('Keep meeting',()=>{view.cancelReview=false;paint();},{class:'quiet',disabled:view.busy})])]),
 ]);}
 function paint(){const title=view.confirmation?.title||view.availability?.settings.title||'Book a meeting';root.replaceChildren(...[
  node('header',{},[node('p',{class:'eyebrow',text:'A TIME TO CONNECT'}),node('h1',{text:title}),note('Choose a time, review the details, and confirm.')]),
  view.error&&node('p',{class:'error',role:'alert',text:view.error}),view.notice&&node('p',{class:'notice',role:'status',text:view.notice}),
  view.error&&!view.availability&&!view.pending&&!view.confirmation&&button('View available times',()=>{view.token='';history.replaceState(null,'','/');load();},{class:'quiet',disabled:view.busy}),
  view.confirmation?successPanel():view.pending?reviewPanel():[availabilityPanel(),view.slot&&contactPanel()],
  view.busy&&node('p',{class:'note',role:'status',text:'Please wait…'}),node('footer',{},[note('This page shows available times only. Other calendar events remain private.')]),
 ].flat(Infinity).filter(Boolean));}
 const fragment=new URLSearchParams((location.hash||'').replace(/^#/,'')),id=fragment.get('booking'),token=fragment.get('token');
 paint();
 if(id&&token){view.token=token;act(async()=>{view.confirmation=await api('confirmation',{id,token});});}
 else{
  try{const pending=JSON.parse(storage.getItem(PENDING));if(pending?.payload?.nonce&&pending?.review&&(pending.sent||pending.review.expiresAt>Date.now())){view.pending=pending.payload;view.review=pending.review;view.uncertain=!!pending.sent;view.name=pending.payload.name;view.email=pending.payload.email;paint();}else storage.removeItem(PENDING);}catch{}
  if(!view.pending)load();
 }
 return {refresh:load};
}
if(typeof document!=='undefined'&&document.getElementById?.('app'))mountGuest(document.getElementById('app'));
