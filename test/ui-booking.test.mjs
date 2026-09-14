import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,findButton,text,settle} from './helpers/ui-dom.mjs';
let sequence=0;
async function fixture(t,{failLoad=false}={}){
 const document=installDom(t),{api}=await import('../ui/lib/api.js'),calls=[];
 const data={settings:{title:'My availability',timezone:'America/Indiana/Indianapolis',startTime:'09:00',endTime:'17:00',durationMinutes:30,bufferMinutes:15,minNoticeMinutes:120,horizonDays:14,weekdays:[1,2,3,4,5],enabled:true,updatedAt:'revision-one'},published:false,guestReady:false,url:null,
  bookings:[{id:'meeting-one',name:'Synthetic guest',email:'guest@example.com',timezone:'America/Indiana/Indianapolis',startsAt:'2026-09-14T14:00:00Z',state:'confirmed',note:'A public meeting topic'}]};
 const handlers={booking:async()=>{if(failLoad)throw new Error('Synthetic unavailable');return structuredClone(data);},saveBookingSettings:async input=>{calls.push({kind:'save',input});data.settings={...data.settings,...input,updatedAt:'revision-two'};return {settings:data.settings};},
  bookingSlots:async()=>({settings:{timezone:data.settings.timezone},slots:[{startsAt:'2026-09-14T15:00:00Z'}]}),cancelBooking:async id=>{calls.push({kind:'cancel',id});data.bookings.find(row=>row.id===id).state='cancelled';return {};}};
 for(const name of Object.keys(handlers))t.mock.method(api,name,(...args)=>handlers[name](...args));
 const module=await import(`../ui/views/booking.js?fixture=${++sequence}`),view=document.body.appendChild(module.renderBooking());await settle();
 return {view,data,handlers,calls,document,module,input(label,value){const node=view.querySelector(`[aria-label="${label}"]`);node.value=value;node.fire('input');},async click(label){findButton(view,label).click();await settle();}};
}
test('refresh and cancellation update bookings without losing unsaved availability',async t=>{
 const f=await fixture(t);f.input('Page title','My unsaved title');f.input('From','10:00');
 await f.click('Refresh bookings');assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'My unsaved title');
 await f.click('Cancel booking');assert.match(text(f.view),/Cancelled/);assert.equal(f.view.querySelector('[aria-label="From"]').value,'10:00');
 assert.equal(f.calls.filter(call=>call.kind==='save').length,0);
 await f.click('Save availability');assert.equal(f.calls.find(call=>call.kind==='save').input.title,'My unsaved title');assert.equal(f.calls.find(call=>call.kind==='save').input.expectedUpdatedAt,'revision-one');
});
test('saving new availability invalidates old slot previews and states that previews use saved settings',async t=>{
 const f=await fixture(t);await f.click('Preview available times');assert.ok(f.view.querySelector('.booking-slots'));
 assert.match(text(f.view),/Preview uses your saved availability/);f.input('From','11:00');await f.click('Save availability');assert.equal(f.view.querySelector('.booking-slots'),null);
 assert.equal(f.data.settings.startTime,'11:00');
});
test('returning to Booking refreshes confirmed meetings while retaining an availability draft',async t=>{
 const f=await fixture(t);f.input('Page title','My draft title');f.view.remove();f.data.bookings[0].state='cancelled';
 f.document.body.appendChild(f.module.renderBooking());await settle();assert.match(text(f.view),/Cancelled/);assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'My draft title');
 assert.equal(f.view.querySelectorAll('a').length,0,'Unpublished, unconfigured guest URLs are not invented');
});
test('failed initial availability can be retried without claiming it is still loading',async t=>{
 const f=await fixture(t,{failLoad:true});assert.match(text(f.view),/Availability could not be loaded/);assert.doesNotMatch(text(f.view),/Loading your availability/);
 f.handlers.booking=async()=>structuredClone(f.data);await f.click('Retry availability');assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'My availability');
});
test('untouched availability refreshes from other sessions and explicit reload can discard a stale edit',async t=>{
 const f=await fixture(t);f.data.settings.title='Changed in another tab';f.data.settings.updatedAt='external-revision';
 await f.click('Refresh bookings');assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'Changed in another tab');
 f.input('Page title','My unsaved edit');f.data.settings.title='Newest saved title';await f.click('Refresh bookings');
 assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'My unsaved edit');await f.click('Reload saved availability');
 assert.equal(f.view.querySelector('[aria-label="Page title"]').value,'Newest saved title');assert.equal(f.calls.filter(call=>call.kind==='save').length,0);
});
