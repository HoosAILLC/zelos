import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {open,migrate,close,listEvents} from '../core/db.mjs';
import {migrateBooking,saveBookingSettings,listBookings} from '../core/booking.mjs';
import {createBookingService} from '../core/booking-service.mjs';
import {createBookingGuestServer,listenBookingGuest,migrateBookingGuest} from '../core/booking-guest.mjs';
import {installDom,text,findButton,settle} from './helpers/ui-dom.mjs';

const origin='http://127.0.0.1:7780',when='2026-09-11T08:00:00Z';
const contact={name:'Synthetic Guest',email:'guest@example.test',startsAt:'2026-09-11T10:00:00.000Z'};
async function fixture(t,{rateLimits,reader=async()=>[{uid:'private',title:'PRIVATE OWNER APPOINTMENT',description:'DO NOT EXPOSE',startsAt:'2026-09-11T09:00:00Z',endsAt:'2026-09-11T09:30:00Z'}]}={}){
 const db=open(':memory:');migrate(db);migrateBooking(db);migrateBookingGuest(db);
 saveBookingSettings(db,{enabled:true,title:'Studio introduction',timezone:'UTC',weekdays:[1,2,3,4,5],startTime:'09:00',endTime:'12:00',durationMinutes:30,bufferMinutes:0,minNoticeMinutes:0});
 const cfg={identity:{timezone:'UTC',email:'OWNER-PRIVATE@example.test'},calendars:[{id:'private-calendar',kind:'ics',url:'https://calendar.example.invalid/private'}]};
 const stats={reads:0,reserves:0};let read=reader;
 const service=createBookingService({db,config:()=>cfg,now:()=>Date.parse(when),readCalendar:async(...args)=>{stats.reads++;return read(...args);}});
 const nativeReserve=service.reserve.bind(service);service.reserve=(...args)=>{stats.reserves++;return nativeReserve(...args);};
 let server=createBookingGuestServer({bookingService:service,db,origin,rateLimits});let address=await listenBookingGuest(server,{port:0});
 const call=(method,url,body,headers={})=>new Promise((resolve,reject)=>{
  const raw=body===undefined?null:typeof body==='string'?body:JSON.stringify(body);
  const req=http.request({hostname:'127.0.0.1',port:address.port,path:url,method,headers:{Host:new URL(origin).host,...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(raw!==null?{'Content-Length':Buffer.byteLength(raw)}:{}),...headers}},res=>{let chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});});req.on('error',reject);if(raw!==null)req.write(raw);req.end();
 });
 const stop=()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
 t.after(async()=>{await stop();await service.stop();close(db);});
 return {db,service,stats,call,setReader:value=>{read=value;},address,review:async(input=contact)=>{const result=await call('POST','/guest/review',input);assert.equal(result.status,200,result.text);return result.data;},
  restart:async()=>{await stop();server=createBookingGuestServer({bookingService:service,db,origin,rateLimits});address=await listenBookingGuest(server,{port:0});},
 };
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

test('guest migration repeats safely within a root schema transaction',()=>{
 const db=open(':memory:');try{db.exec('BEGIN');migrateBookingGuest(db);migrateBookingGuest(db);db.exec('COMMIT');assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_guest_reviews').get().n,0);}finally{close(db);}
});
test('guest listener binds only loopback and rejects invalid origins',async t=>{
 const f=await fixture(t);assert.equal(f.address.address,'127.0.0.1');
 assert.throws(()=>listenBookingGuest(http.createServer(),{host:'0.0.0.0'}),/loopback|127/);
 for(const bad of ['http://public.example','https://user:pass@example.test','https://example.test/path','https://example.test/?token=x','https://example.test/#x'])assert.throws(()=>createBookingGuestServer({bookingService:f.service,db:f.db,origin:bad}));
 const server=createBookingGuestServer({bookingService:f.service,db:f.db,origin:'https://booking.example.test:8443'});server.close();
});
test('only the three guest assets are readable; private paths, GET actions and query tokens are refused',async t=>{
 const f=await fixture(t);
 for(const path of ['/','/app.js','/app.css']){const result=await f.call('GET',path);assert.equal(result.status,200,path);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['referrer-policy'],'no-referrer');assert.match(result.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.headers['x-zelos-token'],undefined);assert.equal(result.headers['access-control-allow-origin'],undefined);}
 for(const path of ['/api/state','/api/config','/api/booking','/core/secrets.mjs','/assets/icon.svg','/../core/config.mjs','/%2e%2e/core/config.mjs','//app.js','/guest/availability','/guest/reserve','/guest/cancel','/guest/calendar?token=secret','/?t=private-token'])assert.equal((await f.call('GET',path)).status,404,path);
 assert.equal(f.stats.reads,0);assert.equal(listBookings(f.db).length,0);
});
test('forged Host, Origin, fetch site and CORS preflight cannot reach booking operations',async t=>{
 const f=await fixture(t);
 for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'},{Origin:'null'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await f.call('POST','/guest/availability',{},headers)).status,403);
 assert.equal((await f.call('OPTIONS','/guest/reserve',undefined,{Origin:origin})).status,404);
 const result=await f.call('POST','/guest/availability',{from:'2026-09-11',to:'2026-09-11'},{'X-Forwarded-Host':'evil.example','X-Forwarded-For':'1.2.3.4','Tailscale-User-Login':'private-owner@example.test'});
 assert.equal(result.status,200);assert.doesNotMatch(result.text,/PRIVATE OWNER|DO NOT EXPOSE|OWNER-PRIVATE|private-calendar|Tailscale|1\.2\.3\.4/);
 assert.deepEqual(Object.keys(result.data.settings).sort(),['durationMinutes','enabled','timezone','title']);
});
test('strict JSON and request size limits refuse unsupported bodies without side effects',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call('POST','/guest/review','x'.repeat(4097))).status,413);
 assert.equal((await f.call('POST','/guest/review','{}',{'Content-Type':'text/plain'})).status,415);
 assert.equal((await f.call('POST','/guest/review','{}',{'Content-Encoding':'gzip'})).status,415);
 assert.equal((await f.call('POST','/guest/review','not JSON')).status,400);
 assert.equal((await f.call('POST','/guest/availability',{now:'2020-01-01'})).status,400);
 assert.equal((await f.call('POST','/guest/review',{...contact,ownerToken:'not-allowed'})).status,400);
 assert.equal(listBookings(f.db).length,0);
});
test('global and peer rate limits apply even when forwarded addresses are forged',async t=>{
 const f=await fixture(t,{rateLimits:{global:4,peer:2,writes:4}});
 assert.equal((await f.call('GET','/')).status,200);assert.equal((await f.call('GET','/app.js')).status,200);
 const denied=await f.call('GET','/app.css',undefined,{'X-Forwarded-For':'8.8.8.8'});assert.equal(denied.status,429);assert.equal(denied.headers['retry-after'],'60');
 const g=await fixture(t,{rateLimits:{global:1,peer:10,writes:10}});assert.equal((await g.call('GET','/')).status,200);assert.equal((await g.call('GET','/')).status,429);
});
test('review creates no reservation, binds exact details and stores no readable guest secret',async t=>{
 const f=await fixture(t),review=await f.review();assert.equal(listBookings(f.db).length,0);
 assert.match(review.nonce,/^[A-Za-z0-9_-]{43}$/);const row=f.db.prepare('SELECT * FROM booking_guest_reviews').get();assert.equal(row.nonce_hash,digest(review.nonce));assert.equal(row.state,'review');assert.doesNotMatch(JSON.stringify(row),/Synthetic Guest|guest@example|PRIVATE/);assert.ok(!JSON.stringify(row).includes(review.nonce));
 const changed=await f.call('POST','/guest/reserve',{...contact,name:'Changed person',nonce:review.nonce});assert.equal(changed.status,409);assert.equal(f.stats.reserves,0);
});
test('confirmation reserves atomically with encrypted receipt, mirrors the calendar, and retries after restart',async t=>{
 const f=await fixture(t),review=await f.review(),input={...contact,nonce:review.nonce};
 const first=await f.call('POST','/guest/reserve',input);assert.equal(first.status,201,first.text);assert.equal(first.data.invitationSent,false);assert.equal(listBookings(f.db).length,1);assert.equal(listEvents(f.db,{calendarId:'zelos-bookings'}).length,1);
 const row=f.db.prepare('SELECT * FROM booking_guest_reviews').get();assert.equal(row.state,'complete');assert.ok(!JSON.stringify(row).includes(first.data.cancellationToken));assert.ok(!JSON.stringify(row).includes(review.nonce));assert.doesNotMatch(JSON.stringify(row),/Synthetic Guest|guest@example/);
 await f.restart();const again=await f.call('POST','/guest/reserve',input);assert.equal(again.status,200);assert.equal(again.data.replayed,true);assert.equal(again.data.booking.id,first.data.booking.id);assert.equal(again.data.cancellationToken,first.data.cancellationToken);assert.equal(f.stats.reserves,1);
 assert.doesNotMatch(first.text,/PRIVATE OWNER|DO NOT EXPOSE|guest@example|Synthetic Guest/);
});
test('individual confirmation, ICS and cancellation require the guest token in a POST body',async t=>{
 const f=await fixture(t),review=await f.review(),booked=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce}),id=booked.data.booking.id,token=booked.data.cancellationToken;
 for(const route of ['confirmation','calendar','cancel'])assert.equal((await f.call('POST',`/guest/${route}`,{id,token:'A'.repeat(43)})).status,404);
 const confirmation=await f.call('POST','/guest/confirmation',{id,token});assert.equal(confirmation.status,200);assert.doesNotMatch(confirmation.text,/guest@example|PRIVATE OWNER/);
 const ics=await f.call('POST','/guest/calendar',{id,token});assert.equal(ics.status,200);assert.match(ics.text,/BEGIN:VEVENT/);assert.doesNotMatch(ics.text,/PRIVATE OWNER|Synthetic Guest|guest@example/);assert.ok(!ics.text.includes(token));assert.match(ics.headers['content-disposition'],/meeting\.ics/);
 const cancelled=await f.call('POST','/guest/cancel',{id,token});assert.equal(cancelled.data.booking.state,'cancelled');assert.equal(listEvents(f.db,{calendarId:'zelos-bookings'})[0].status,'CANCELLED');
 assert.equal((await f.call('POST','/guest/cancel',{id,token})).data.booking.state,'cancelled');
 const replay=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(replay.data.booking.state,'cancelled');assert.equal(listBookings(f.db).length,1);
});
test('stale calendars refuse reservations and do not produce a success receipt',async t=>{
 const f=await fixture(t),review=await f.review();f.setReader(async()=>{throw Error('PRIVATE CREDENTIAL ERROR');});
 const response=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(response.status,503);assert.doesNotMatch(response.text,/PRIVATE CREDENTIAL/);assert.equal(listBookings(f.db).length,0);assert.equal(f.db.prepare('SELECT state FROM booking_guest_reviews').get().state,'failed');
 const retry=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(retry.data.notBooked,true);assert.equal(f.stats.reserves,1);
});
test('simultaneous identical submissions claim one reservation and recover its result',async t=>{
 const f=await fixture(t),review=await f.review(),input={...contact,nonce:review.nonce};let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
 const original=f.service.reserve;f.service.reserve=async(...args)=>{entered();await gate;return original(...args);};
 const first=f.call('POST','/guest/reserve',input);await started;const second=await f.call('POST','/guest/reserve',input);assert.equal(second.status,409);assert.equal(second.data.uncertain,true);release();
 const result=await first;assert.equal(result.status,201);assert.equal((await f.call('POST','/guest/reserve',input)).data.booking.id,result.data.booking.id);assert.equal(f.stats.reserves,1);
});
test('post-commit response failure is recovered, while unknown failures stay locked across restart',async t=>{
 const f=await fixture(t),review=await f.review(),original=f.service.reserve;f.service.reserve=async(...args)=>{await original(...args);throw Error('Synthetic lost response after commit');};
 const recovered=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(recovered.status,200);assert.equal(recovered.data.replayed,true);assert.equal(listBookings(f.db).length,1);
 const g=await fixture(t),pending=await g.review();let calls=0;g.service.reserve=async()=>{calls++;throw Error('Synthetic unknown failure');};
 const failed=await g.call('POST','/guest/reserve',{...contact,nonce:pending.nonce});assert.equal(failed.data.uncertain,true);await g.restart();assert.equal((await g.call('POST','/guest/reserve',{...contact,nonce:pending.nonce})).data.uncertain,true);assert.equal(calls,1);
});
test('receipt-write failure rolls back the booking and mirror, with no automatic retry',async t=>{
 const f=await fixture(t),review=await f.review();f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF response_enc ON booking_guest_reviews BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END;");
 const response=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(response.data.uncertain,true);assert.equal(listBookings(f.db).length,0);assert.equal(listEvents(f.db,{calendarId:'zelos-bookings'}).length,0);
 assert.equal((await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce})).data.uncertain,true);assert.equal(f.stats.reserves,1);
});
test('expired encrypted receipts are purged and expired nonces cannot create new reservations',async t=>{
 const f=await fixture(t),review=await f.review();f.db.prepare('UPDATE booking_guest_reviews SET expires_at=?').run(Date.now()-1);
 const response=await f.call('POST','/guest/reserve',{...contact,nonce:review.nonce});assert.equal(response.status,409);assert.equal(response.data.uncertain,true);assert.equal(f.stats.reserves,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM booking_guest_reviews').get().n,0);
});

test('tampered ciphertext and a different nonce cannot reveal or recreate a confirmation',async t=>{
 const f=await fixture(t),review=await f.review(),payload={...contact,nonce:review.nonce};await f.call('POST','/guest/reserve',payload);
 assert.equal((await f.call('POST','/guest/reserve',{...payload,nonce:crypto.randomBytes(32).toString('base64url')})).status,409);
 const row=f.db.prepare('SELECT response_enc FROM booking_guest_reviews').get(),encrypted=JSON.parse(row.response_enc);encrypted.body=Buffer.from('changed ciphertext').toString('base64url');
 f.db.prepare('UPDATE booking_guest_reviews SET response_enc=?').run(JSON.stringify(encrypted));const response=await f.call('POST','/guest/reserve',payload);assert.equal(response.status,409);assert.equal(response.data.uncertain,true);assert.equal(f.stats.reserves,1);assert.equal(listBookings(f.db).length,1);
});

test('guest browser requires review and confirmation, keeps tokens out of query strings, and confirms cancellation',async t=>{
 const f=await fixture(t),document=installDom(t),{mountGuest,slotLabel}=await import('../assets/booking-guest/app.js');
 const root=document.body.appendChild(document.createElement('main')),memory=new Map(),paths=[],calls=[];
 const api=async(route,body)=>{calls.push({route,body});const response=await f.call('POST',`/guest/${route}`,body);if(response.status>=400){const error=new Error(response.data.error);Object.assign(error,response.data);throw error;}return response.data;};
 mountGuest(root,{api,storage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},location:{origin,hash:''},history:{replaceState:(_a,_b,path)=>paths.push(path)}});
 for(let n=0;n<30&&!root.querySelector('.slots');n++)await new Promise(resolve=>setTimeout(resolve,5));
 const slotButton=findButton(root,slotLabel(contact,Intl.DateTimeFormat().resolvedOptions().timeZone));assert.ok(slotButton);slotButton.click();
 for(const [label,value] of [['Name',contact.name],['Email',contact.email]]){const input=root.querySelector(`[aria-label="${label}"]`);input.value=value;input.fire('input');}
 root.querySelectorAll('form').at(-1).fire('submit');
 for(let n=0;n<30&&!findButton(root,'Confirm booking');n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(findButton(root,'Confirm booking'));assert.equal(listBookings(f.db).length,0);assert.match(text(root),/No invitation email/);
 findButton(root,'Confirm booking').click();for(let n=0;n<30&&!findButton(root,'Cancel meeting');n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(listBookings(f.db).length,1);assert.equal(new URL(paths[0]).search,'');assert.match(new URL(paths[0]).hash,/#booking=.*&token=/);assert.equal(memory.size,0);
 findButton(root,'Cancel meeting').click();assert.equal(calls.filter(call=>call.route==='cancel').length,0);findButton(root,'Yes, cancel meeting').click();
 for(let n=0;n<30&&listBookings(f.db)[0].state!=='cancelled';n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(listBookings(f.db)[0].state,'cancelled');await settle();
});
