/** Owner availability settings and confirmed bookings. Guest publishing is separate. */
import {el,button} from '../lib/dom.js';
import {api} from '../lib/api.js';
import {disclosure,reveal} from '../lib/workspace.js';
const cache={root:null,data:null,settings:null,settingsDirty:false,busy:false,loading:false,error:'',slots:null,notice:''};
const note=text=>el('p',{class:'booking-note',text});
function field(label,key,type='text'){
 const input=el('input',{class:'input',type,disabled:cache.busy,value:cache.settings[key]??'','aria-label':label});
 input.addEventListener('input',()=>{cache.settings[key]=type==='number'?Number(input.value):input.value;cache.settingsDirty=true;});
 return el('label',{class:'booking-field'},[el('span',{text:label}),input]);
}
async function load({keepEdits=false}={}){if(cache.loading)return;cache.loading=true;try{cache.data=await api.booking();if(!keepEdits||!cache.settings||!cache.settingsDirty){cache.settings={...cache.data.settings};cache.settingsDirty=false;}cache.error='';}catch(error){cache.error=error.message;}finally{cache.loading=false;paint();}}
async function run(operation){if(cache.busy)return;cache.busy=true;cache.error='';paint();try{await operation();}catch(error){cache.error=error.message;}finally{cache.busy=false;paint();}}
function paint(){
 if(!cache.root)return;
 const nodes=[el('header',{class:'booking-heading'},[
  el('div',{},[el('h1',{text:'Booking'}),note('Your meetings and availability.')]),
  button('Edit availability',{class:'btn solid',disabled:!cache.settings,onClick:()=>{const editor=cache.root.querySelector('.booking-editor');if(editor){editor.open=true;reveal(editor.querySelector('.workspace-disclosure-body'));}}}),
 ])];
 if(cache.error)nodes.push(el('p',{class:'booking-error',role:'alert',text:cache.error}));
 if(cache.notice)nodes.push(el('p',{class:'booking-note',role:'status',text:cache.notice}));
 if(!cache.settings){nodes.push(note(cache.error?'Availability could not be loaded.':'Loading your availability…'));if(cache.error)nodes.push(button('Retry availability',{class:'btn quiet',disabled:cache.loading,onClick:()=>load()}));cache.root.replaceChildren(...nodes);return;}
 const saved=cache.data.settings,dayLabels=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
 nodes.push(el('section',{class:'booking-summary'},[
  el('div',{},[el('span',{class:'workspace-caption',text:'BOOKING PAGE'}),el('h2',{text:saved.enabled?'Open for bookings':'Bookings are paused'}),note(`${saved.durationMinutes} minute meetings · ${saved.timezone}`)]),
  el('div',{class:'booking-schedule'},[el('strong',{text:saved.weekdays.map(day=>dayLabels[day]).join(' · ')||'No days selected'}),note(`${saved.startTime} – ${saved.endTime}`)]),
  cache.data.guestReady?el('a',{class:'btn quiet',href:cache.data.url,target:'_blank',rel:'noopener noreferrer',text:cache.data.published?'Open booking page':'Preview guest page'}):null,
  note(cache.data.published?'Share your booking page so guests can choose a time.':'Private preview · Your guest page has not been published.'),
 ]));
 const bookings=cache.data.bookings||[],confirmed=bookings.filter(item=>item.state!=='cancelled'),cancelled=bookings.filter(item=>item.state==='cancelled');
 const bookingRow=item=>el('article',{class:'booking-row'},[
  el('div',{class:'booking-date'},[el('strong',{text:new Intl.DateTimeFormat(undefined,{timeZone:item.timezone,month:'short',day:'numeric'}).format(new Date(item.startsAt))}),note(new Intl.DateTimeFormat(undefined,{timeZone:item.timezone,hour:'numeric',minute:'2-digit'}).format(new Date(item.startsAt)))]),
  el('div',{class:'booking-person'},[el('strong',{text:item.name}),note(item.email),item.note?disclosure(`booking-note-${item.id}`,'Meeting note',[note(item.note)]):null]),
  item.state==='cancelled'?note('Cancelled'):button('Cancel booking',{class:'btn quiet',disabled:cache.busy,onClick:()=>run(async()=>{await api.cancelBooking(item.id);cache.slots=null;await load({keepEdits:true});})}),
 ]);
 nodes.push(el('section',{class:'booking-card'},[
  el('div',{class:'workspace-section-head'},[el('h2',{text:'Scheduled meetings'}),button('Refresh bookings',{class:'btn quiet',disabled:cache.busy,onClick:()=>run(async()=>{cache.slots=null;await load({keepEdits:true});})})]),
  ...(confirmed.length?confirmed.map(bookingRow):[el('div',{class:'workspace-empty'},[el('h2',{text:'Your next meeting starts here'}),note('Confirmed meetings will appear here when someone books a time.')])]),
  note('Bookings appear in your Zelos calendar. Guests can download a calendar event; email invitations are not sent.'),
 ]));
 const enabled=el('input',{type:'checkbox','aria-label':'Accept bookings',disabled:cache.busy});enabled.checked=cache.settings.enabled;enabled.addEventListener('change',()=>{cache.settings.enabled=enabled.checked;cache.settingsDirty=true;});
 const days=el('div',{class:'booking-days'});
 for(const [day,label] of dayLabels.entries()){
  const input=el('input',{type:'checkbox','aria-label':label,disabled:cache.busy});input.checked=cache.settings.weekdays.includes(day);
  input.addEventListener('change',()=>{cache.settings.weekdays=input.checked?[...new Set([...cache.settings.weekdays,day])]:cache.settings.weekdays.filter(x=>x!==day);cache.settingsDirty=true;});
  days.appendChild(el('label',{},[input,el('span',{text:label})]));
 }
 const save=button(cache.busy?'Saving…':'Save availability',{class:'btn solid',disabled:cache.busy,onClick:()=>run(async()=>{await api.saveBookingSettings({...cache.settings,expectedUpdatedAt:cache.settings.updatedAt});cache.settingsDirty=false;cache.slots=null;cache.notice='Availability saved.';await load();})});
 nodes.push(disclosure('booking-settings','Availability settings',[
  el('label',{class:'booking-switch'},[enabled,el('span',{text:'Accept bookings'})]),
  el('div',{class:'booking-grid'},[field('Page title','title'),field('Time zone','timezone')]),
  el('div',{},[el('p',{class:'booking-note',text:'Available days'}),days]),
  el('div',{class:'booking-grid booking-hours'},[field('From','startTime','time'),field('Until','endTime','time'),field('Meeting length (minutes)','durationMinutes','number')]),
  disclosure('booking-buffers','Buffers and booking window',[el('div',{class:'booking-grid'},[field('Time between meetings (minutes)','bufferMinutes','number'),field('Minimum notice (minutes)','minNoticeMinutes','number'),field('How many days ahead','horizonDays','number')])]),
  el('div',{class:'workspace-actions'},[save,button('Reload saved availability',{class:'btn quiet',disabled:cache.busy,onClick:()=>run(async()=>{cache.slots=null;await load();})})]),
 ],{className:'booking-editor'}));
 const check=button(cache.busy?'Checking…':'Preview available times',{class:'btn quiet',disabled:cache.busy||!saved.enabled,onClick:()=>run(async()=>{cache.slots=await api.bookingSlots();})});
 nodes.push(disclosure('booking-times','Available times',[
  note('Preview uses your saved availability and checks for calendar conflicts.'),check,
  ...(cache.slots?[note(`Times shown in ${cache.slots.settings.timezone}.`),cache.slots.slots.length?el('div',{class:'booking-slots'},cache.slots.slots.slice(0,60).map(slot=>el('span',{class:'booking-slot',text:new Intl.DateTimeFormat(undefined,{timeZone:cache.slots.settings.timezone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(slot.startsAt))}))):note('No times are currently available in this window.')]:[]),
 ]));
 if(cancelled.length)nodes.push(disclosure('booking-cancelled',`Cancelled meetings · ${cancelled.length}`,cancelled.map(bookingRow)));
 cache.root.replaceChildren(...nodes);
}

export function renderBooking(){if(!cache.root){cache.root=el('div',{class:'view view-booking'});load();paint();}else if(!cache.root.isConnected&&!cache.busy&&!cache.loading){cache.slots=null;load({keepEdits:true});}return cache.root;}
