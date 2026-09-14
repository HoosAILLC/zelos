import test from 'node:test';
import assert from 'node:assert/strict';
import {open,migrate,close,listEvents} from '../core/db.mjs';
import {migrateBooking,saveBookingSettings,listBookings} from '../core/booking.mjs';
import {createBookingService,bookingCalendarFile} from '../core/booking-service.mjs';
function fixture(t,readCalendar){const db=open(':memory:');migrate(db);migrateBooking(db);saveBookingSettings(db,{enabled:true,title:'Planning call',timezone:'UTC',weekdays:[1,2,3,4,5],minNoticeMinutes:0,horizonDays:10,bufferMinutes:0});const config={identity:{timezone:'UTC'},calendars:[{id:'work',kind:'ics',url:'https://example.invalid/calendar'}]};const service=createBookingService({db,config:()=>config,readCalendar,now:()=>Date.parse('2026-09-11T08:00:00Z')});t.after(async()=>{await service.stop();close(db);});return {db,service,config};}
test('booking checks every calendar, caches complete reads, and mirrors reservations into the owner calendar',async t=>{
 let calls=0;const {db,service}=fixture(t,async()=>{calls++;return [{uid:'existing',title:'Private meeting',startsAt:'2026-09-11T09:00:00Z',endsAt:'2026-09-11T10:00:00Z'}];});
 const slots=await service.slots({from:'2026-09-11',to:'2026-09-11'});assert.equal(slots.slots[0].startsAt,'2026-09-11T10:00:00.000Z');assert.ok(!JSON.stringify(slots).includes('Private meeting'));
 await service.slots({from:'2026-09-11',to:'2026-09-11'});assert.equal(calls,1);
 const result=await service.reserve({startsAt:slots.slots[0].startsAt,name:'Sam',email:'sam@example.com'});assert.equal(calls,2);assert.equal(result.invitationSent,false);
 const owner=listEvents(db,{calendarId:'zelos-bookings'});assert.equal(owner.length,1);assert.match(owner[0].title,/Sam/);
 const ics=bookingCalendarFile(db,{id:result.booking.id,token:result.cancellationToken}).toString();assert.match(ics,/BEGIN:VEVENT/);assert.match(ics,/METHOD:PUBLISH/);assert.ok(!ics.includes('Private meeting'));assert.ok(!ics.includes(result.cancellationToken));
 service.cancel({id:result.booking.id,token:result.cancellationToken});assert.equal(listEvents(db,{calendarId:'zelos-bookings'})[0].status,'CANCELLED');
 assert.throws(()=>bookingCalendarFile(db,{id:result.booking.id,token:'A'.repeat(43)}),/invalid/);
});
test('failed reads and changed calendar settings cannot confirm a meeting from a partial or stale snapshot',async t=>{
 const {db,service,config}=fixture(t,async()=>{throw Error('No calendar access');});
 await assert.rejects(service.slots({from:'2026-09-11',to:'2026-09-11'}),/could not be checked/);assert.equal(listBookings(db).length,0);
 const {service:changed,db:other,config:settings}=fixture(t,async()=>{settings.calendars[0].url='https://example.invalid/changed';return [];});
 await assert.rejects(changed.reserve({startsAt:'2026-09-11T10:00:00Z',name:'Sam',email:'sam@example.com'}),/settings changed/);assert.equal(listBookings(other).length,0);
});
test('owner cancellation updates the actual calendar and input cannot override the booking clock',async t=>{
 const {service,db}=fixture(t,async()=>[]);
 const past=await service.slots({from:'2026-09-10',to:'2026-09-10',now:'2026-09-01T00:00:00Z'});assert.equal(past.slots.length,0);
 const result=await service.reserve({startsAt:'2026-09-11T10:00:00Z',name:'Sam',email:'sam@example.com'});service.cancelOwner(result.booking.id);assert.equal(listBookings(db)[0].state,'cancelled');assert.equal(listEvents(db,{calendarId:'zelos-bookings'})[0].status,'CANCELLED');
});
test('a reservation cannot inherit a cached concurrent availability read',async t=>{
 let busy=false,calls=0;const {service,db}=fixture(t,async()=>{calls++;return busy?[{uid:'new-conflict',title:'New private meeting',startsAt:'2026-09-11T10:00:00Z',endsAt:'2026-09-11T11:00:00Z'}]:[];});
 await service.slots({from:'2026-09-11',to:'2026-09-11'});busy=true;
 const cached=service.slots({from:'2026-09-11',to:'2026-09-11'});
 await assert.rejects(service.reserve({startsAt:'2026-09-11T10:00:00Z',name:'Sam',email:'sam@example.com'}),/available|taken|reserved/i);await cached;
 assert.equal(calls,2);assert.equal(listBookings(db).length,0);
});
test('cancellation rolls back if its owner calendar update fails',async t=>{
 const {service,db}=fixture(t,async()=>[]);const result=await service.reserve({startsAt:'2026-09-11T10:00:00Z',name:'Sam',email:'sam@example.com'});
 db.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE ON events WHEN NEW.status='CANCELLED' BEGIN SELECT RAISE(ABORT,'synthetic calendar failure'); END");
 assert.throws(()=>service.cancelOwner(result.booking.id),/synthetic calendar failure/);assert.equal(listBookings(db)[0].state,'confirmed');assert.equal(listEvents(db,{calendarId:'zelos-bookings'})[0].status,'CONFIRMED');
});
