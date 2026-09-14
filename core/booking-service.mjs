/** Fresh calendar reads, local booking reservations, and individual calendar files. */
import crypto from 'node:crypto';
import {get as connectorFor} from './connectors/index.mjs';
import {getSecret} from './secrets.mjs';
import {upsertEvents,reconcileEvents,upsertEvent,getKV,setKV,withTransaction} from './db.mjs';
import {recordSourceResults} from './source-status.mjs';
import {BookingError,getBookingSettings,listBookingSlots,createBooking,cancelBooking,cancelOwnerBooking,getBookingForGuest,listBookings} from './booking.mjs';
const CALENDAR='zelos-bookings';
function sources(config){return (config.calendars||[]).filter(c=>c.enabled!==false);}
const fingerprint=config=>crypto.createHash('sha256').update(JSON.stringify({sources:sources(config),timezone:config.identity?.timezone,email:config.identity?.email})).digest('hex');
async function defaultRead(source,config,window,signal){
 const connector=connectorFor(source.kind)||connectorFor('ics');
 if(typeof connector?.read!=='function')throw new BookingError('A connected calendar cannot be checked for booking.',503);
 const result=await connector.read({source,pass:source.keyRef?await getSecret(source.keyRef):null,window:{...window,tzid:config.identity?.timezone,email:config.identity?.email,max:5000},signal});
 if(result.truncated||result.incomplete||!Array.isArray(result.events))throw new BookingError('A calendar could not be checked completely. Booking is temporarily unavailable.',503);
 return result.events;
}
function mirror(db,booking,settings){
 upsertEvent(db,{calendarId:CALENDAR,uid:booking.id,title:`${settings.title} · ${booking.name}`,description:booking.note||'',startsAt:booking.startsAt,endsAt:booking.endsAt,attendees:[{name:booking.name,email:booking.email}],status:booking.state==='confirmed'?'CONFIRMED':'CANCELLED'});
}
export function reconcileBookingEvents(db){const settings=getBookingSettings(db);for(const booking of listBookings(db))mirror(db,booking,settings);}
export function createBookingService({db,config,readCalendar=defaultRead,now=()=>Date.now()}){
 let refreshing=null,closed=false;const abort=new AbortController();
 reconcileBookingEvents(db);
 async function performRefresh(force){
  const cfg=config(),settings=getBookingSettings(db),key=fingerprint(cfg),start=now();
  let previous;try{previous=JSON.parse(getKV(db,'booking.calendar_snapshot'));}catch{}
  const horizonEnd=start+(settings.horizonDays+2)*86400000;
  if(!force&&previous?.key===key&&start-previous.at<300000&&previous.to>=horizonEnd-300000)return previous;
  const window={from:new Date(start-86400000).toISOString(),to:new Date(horizonEnd).toISOString()};
  const readings=await Promise.all(sources(cfg).map(async source=>({source,events:await readCalendar(source,cfg,window,abort.signal)})));
  abort.signal.throwIfAborted();if(key!==fingerprint(config()))throw new BookingError('Calendar settings changed. Refresh available times.',409);
  db.exec('SAVEPOINT booking_calendar_refresh');
  try{
   for(const {source,events} of readings){
    const scoped=events.map(event=>({...event,calendarId:source.id}));
    upsertEvents(db,scoped,{now:new Date(start).toISOString()});reconcileEvents(db,{calendarId:source.id,events:scoped,from:window.from,to:window.to,timezone:cfg.identity?.timezone||settings.timezone});
   }
   const snapshot={key,at:start,to:horizonEnd};setKV(db,'booking.calendar_snapshot',JSON.stringify(snapshot));
   recordSourceResults(db,readings.map(({source,events})=>({id:source.id,kind:'calendar',ok:true,count:events.length})),new Date(start).toISOString());
   db.exec('RELEASE booking_calendar_refresh');return snapshot;
  }catch(error){db.exec('ROLLBACK TO booking_calendar_refresh; RELEASE booking_calendar_refresh');throw error;}
 }
 async function fresh(force=false){
  if(closed)throw new BookingError('Booking is temporarily unavailable.',503);
  if(refreshing){
   if(!force)return refreshing;
   // A concurrent availability read may be serving its five-minute cache.
   // Reservations always make their own fresh read before claiming the time.
   await refreshing;return fresh(true);
  }
  refreshing=performRefresh(force).catch(error=>{if(error instanceof BookingError)throw error;throw new BookingError('Connected calendars could not be checked. Try again shortly.',503);});
  try{return await refreshing;}finally{refreshing=null;}
 }
 return {
  fresh,
  async slots(input={},options={}){if(getBookingSettings(db).enabled)await fresh();return listBookingSlots(db,{from:input.from,to:input.to},{...options,now:now()});},
  async reserve(input,options={}){await fresh(true);const result=createBooking(db,input,{...options,now:now(),onCreated:(booking,secrets)=>{mirror(db,booking,getBookingSettings(db));return options.onCreated?.(booking,secrets);}});return {...result,calendarFileAvailable:true,invitationSent:false};},
  cancel(input,options={}){return withTransaction(db,()=>{const result=cancelBooking(db,input,options);reconcileBookingEvents(db);return result;});},
  cancelOwner(id){return withTransaction(db,()=>{const result=cancelOwnerBooking(db,id);reconcileBookingEvents(db);return result;});},
  async stop(){closed=true;abort.abort();await refreshing?.catch(()=>{});},
 };
}
const escaped=value=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\\/g,'\\\\').replace(/\r\n?|\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
function folded(line){let rows=[],current='';for(const char of line){if(Buffer.byteLength(current+char)>73){rows.push(current);current=' ';}current+=char;}rows.push(current);return rows.join('\r\n');}
const utc=value=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
/** The token comes in a POST body. No private workspace token or calendar feed is exposed. */
export function bookingCalendarFile(db,input){
 const booking=getBookingForGuest(db,input),settings=getBookingSettings(db);
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Zelos//Private Booking//EN','METHOD:PUBLISH','BEGIN:VEVENT',`UID:${booking.id}@zelos.local`,`DTSTAMP:${utc(new Date())}`,`DTSTART:${utc(booking.starts_at)}`,`DTEND:${utc(booking.ends_at)}`,`SUMMARY:${escaped(settings.title)}`,`STATUS:${booking.state==='confirmed'?'CONFIRMED':'CANCELLED'}`,'END:VEVENT','END:VCALENDAR'];
 return Buffer.from(lines.map(folded).join('\r\n')+'\r\n');
}
