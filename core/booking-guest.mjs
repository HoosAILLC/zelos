/** Separate guest-only listener. No private-app routes or publication side effects. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BookingError, getBookingSettings, getBookingForGuest } from './booking.mjs';
import { bookingCalendarFile } from './booking-service.mjs';
import { toZonedISO } from './time.mjs';

const DEFAULT_ASSETS=fileURLToPath(new URL('../assets/booking-guest/',import.meta.url));
const REVIEW_TTL=15*60000,RECEIPT_TTL=7*86400000,MAX_BODY=4096;
class GuestError extends Error {constructor(message,status=400,extra={}){super(message);this.status=status;this.extra=extra;}}
const fail=(message,status=400,extra)=>{throw new GuestError(message,status,extra);};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonicalOrigin=value=>{
 let url;try{url=new URL(value);}catch{fail('Configure an exact booking origin.',500);}
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||value.replace(/\/$/,'')!==url.origin||!['http:','https:'].includes(url.protocol)
  ||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))fail('Booking needs an exact HTTPS origin, or local HTTP for testing.',500);
 return url;
};
const safeBooking=row=>({id:row.id,startsAt:row.startsAt??row.starts_at,endsAt:row.endsAt??row.ends_at,timezone:row.timezone,durationMinutes:row.durationMinutes??row.duration_minutes,state:row.state});
const HEADERS={
 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
};
export function migrateBookingGuest(db){
 db.exec(`CREATE TABLE IF NOT EXISTS booking_guest_reviews (
  nonce_hash TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('review','processing','complete','failed')),
  response_enc TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS booking_guest_review_expiry ON booking_guest_reviews(expires_at);`);
}
function nonceBytes(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))fail('This booking review is invalid. Review the meeting again.',404);const bytes=Buffer.from(value,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==value)fail('This booking review is invalid.',404);return bytes;}
function encryptionKey(nonce,nonceHash){return crypto.hkdfSync('sha256',nonceBytes(nonce),Buffer.from('Zelos guest booking receipt v1'),Buffer.from(nonceHash),32);}
function encryptResponse(nonce,row,value){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(nonce,row.nonce_hash),iv);
 cipher.setAAD(Buffer.from(`${row.nonce_hash}.${row.payload_hash}`));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return JSON.stringify({iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),body:ciphertext.toString('base64url')});
}
function decryptResponse(nonce,row){
 try{const encoded=JSON.parse(row.response_enc),decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(nonce,row.nonce_hash),Buffer.from(encoded.iv,'base64url'));
  decipher.setAAD(Buffer.from(`${row.nonce_hash}.${row.payload_hash}`));decipher.setAuthTag(Buffer.from(encoded.tag,'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded.body,'base64url')),decipher.final()]).toString('utf8'));
 }catch{fail('The saved confirmation could not be recovered. Contact the meeting organizer before booking again.',409,{uncertain:true});}
}
function meetingInput(input){
 const text=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(`Enter a valid ${label}.`);return value.trim();};
 const name=text(input.name,'name',120),email=text(input.email,'email address',254).toLowerCase(),startsAt=text(input.startsAt,'meeting time',50);
 if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email))fail('Enter a valid email address.');
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(startsAt)||!Number.isFinite(Date.parse(startsAt)))fail('Choose an available meeting time.');
 return {name,email,startsAt:new Date(startsAt).toISOString()};
}
function only(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))fail('This booking request has unsupported fields.');}
function readBody(req){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('Send a JSON booking request.',415);
 if(req.headers['content-encoding'])fail('Compressed booking requests are not accepted.',415);
 if(Number(req.headers['content-length'])>MAX_BODY)fail('The booking request is too large.',413);
 return new Promise((resolve,reject)=>{let size=0,parts=[],settled=false;
  const stop=error=>{if(!settled){settled=true;reject(error);}};
  req.on('data',part=>{size+=part.length;if(size>MAX_BODY){stop(new GuestError('The booking request is too large.',413));parts=[];}else if(!settled)parts.push(part);});
  req.on('aborted',()=>stop(new GuestError('The booking request stopped before completion.',400)));req.on('error',()=>stop(new GuestError('The booking request could not be read.',400)));
  req.on('end',()=>{if(settled)return;settled=true;try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(new GuestError('The booking request could not be read.',400));}});
 });
}
function limiter({windowMs=60000,global=180,peer=90,writes=20}={}){
 const peers=new Map();let window=0,total=0,mutations=0;
 return (key,write)=>{const now=Date.now();if(now-window>=windowMs){window=now;total=0;mutations=0;peers.clear();}
  total++;const count=(peers.get(key)||0)+1;peers.set(key,count);if(write)mutations++;
  if(total>global||count>peer||mutations>writes)fail('Too many booking requests. Please wait a minute.',429);
 };
}
/** The origin is the public proxy origin; forwarded host/identity headers are never trusted. */
export function createBookingGuestServer({bookingService,db,origin,assetsDir=DEFAULT_ASSETS,rateLimits}={}){
 if(!bookingService||!db)fail('A booking service and database are required.',500);
 const expected=canonicalOrigin(origin),rate=limiter(rateLimits);
 const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/app.css',['app.css','text/css; charset=utf-8']]].map(([url,[name,type]])=>[url,{body:fs.readFileSync(path.join(assetsDir,name)),type}]));
 const json=(res,status,value)=>{res.writeHead(status,{...HEADERS,'Content-Type':'application/json; charset=utf-8',...(status===429?{'Retry-After':'60'}:{})});res.end(JSON.stringify(value));};
 const recovered=(nonce,row)=>{const response=decryptResponse(nonce,row);return {...response,booking:safeBooking(getBookingForGuest(db,{id:response.booking.id,token:response.cancellationToken}))};};
 async function reserve(input){
  only(input,['nonce','name','email','startsAt']);nonceBytes(input.nonce);const nonceHash=hash(input.nonce),payload=meetingInput(input),payloadHash=hash(JSON.stringify(payload));
  let row=db.prepare('SELECT * FROM booking_guest_reviews WHERE nonce_hash=?').get(nonceHash);
  if(!row||row.expires_at<Date.now())fail('This review expired. If you already confirmed it, contact the organizer before booking again.',409,{uncertain:true});
  if(row.payload_hash!==payloadHash)fail('The meeting details changed. Review them again before confirming.',409);
  if(row.state==='complete')return {...recovered(input.nonce,row),replayed:true};
  if(row.state==='processing')fail('This request may already be booking a meeting. Keep this page and check the same request again; do not make another reservation.',409,{uncertain:true});
  if(row.state==='failed')fail('This request did not complete. Review the available time again.',409,{notBooked:true});
  if(db.prepare("UPDATE booking_guest_reviews SET state='processing',expires_at=? WHERE nonce_hash=? AND state='review'").run(Date.now()+RECEIPT_TTL,nonceHash).changes!==1)fail('This request is already being processed.',409,{uncertain:true});
  let callbackRan=false;
  try{
   await bookingService.reserve(payload,{onCreated:(record,secrets)=>{
    nonceBytes(secrets?.cancellationToken);callbackRan=true;
    const response={booking:safeBooking(record),cancellationToken:secrets.cancellationToken,title:getBookingSettings(db).title,calendarFileAvailable:true,invitationSent:false};
    const encrypted=encryptResponse(input.nonce,row,response);
    const updated=db.prepare("UPDATE booking_guest_reviews SET state='complete',response_enc=?,expires_at=? WHERE nonce_hash=? AND state='processing'").run(encrypted,Date.now()+RECEIPT_TTL,nonceHash);
    if(updated.changes!==1)throw new Error('The guest receipt could not be committed.');
   }});
   row=db.prepare('SELECT * FROM booking_guest_reviews WHERE nonce_hash=?').get(nonceHash);
   if(row?.state!=='complete')fail('The booking result is uncertain. Contact the organizer before booking again.',409,{uncertain:true});
   return recovered(input.nonce,row);
  }catch(error){
   row=db.prepare('SELECT * FROM booking_guest_reviews WHERE nonce_hash=?').get(nonceHash);
   if(row?.state==='complete')return {...recovered(input.nonce,row),replayed:true};
   // Known input/conflict/calendar failures rolled back the booking transaction.
   // An unexpected failure remains locked; it never automatically re-reserves.
   if(error instanceof BookingError&&[400,404,409,503].includes(error.status)&&!callbackRan){
    db.prepare("UPDATE booking_guest_reviews SET state='failed' WHERE nonce_hash=? AND state='processing'").run(nonceHash);fail(error.message,error.status,{notBooked:true});
   }
   fail('The booking result is uncertain. Keep this page and contact the organizer before booking again.',409,{uncertain:true});
  }
 }
 const server=http.createServer(async(req,res)=>{
  try{
   const hostCount=req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='host').length;
   const originCount=req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='origin').length;
   if(hostCount!==1||req.headers.host!==expected.host||originCount>1)fail('This booking host is not allowed.',403);
   if(req.headers.origin&&req.headers.origin!==expected.origin)fail('This booking origin is not allowed.',403);
   if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))fail('Open the booking page directly.',403);
   const pathname=(req.url||'').split('?')[0],peer=req.socket.remoteAddress||'unknown';
   rate(peer,req.method==='POST'&&['/guest/review','/guest/reserve','/guest/cancel'].includes(pathname));
   if(req.method==='GET'&&assets.has(pathname)&&!req.url.includes('?')){const asset=assets.get(pathname);res.writeHead(200,{...HEADERS,'Content-Type':asset.type});res.end(asset.body);return;}
   const endpoints=['/guest/availability','/guest/review','/guest/reserve','/guest/confirmation','/guest/cancel','/guest/calendar'];
   if(req.method!=='POST'||!endpoints.includes(pathname)||req.url!==pathname)fail('Not found.',404);
   if(req.headers.origin!==expected.origin)fail('Open this booking page before submitting a request.',403);
   const input=await readBody(req);
   db.prepare('DELETE FROM booking_guest_reviews WHERE expires_at < ?').run(Date.now());
   if(pathname==='/guest/availability'){
    only(input,['from','to']);const result=await bookingService.slots(input);json(res,200,{settings:{enabled:result.settings.enabled,title:result.settings.title,timezone:result.settings.timezone,durationMinutes:result.settings.durationMinutes},from:result.from,to:result.to,slots:result.slots.map(slot=>({startsAt:slot.startsAt,endsAt:slot.endsAt}))});return;
   }
   if(pathname==='/guest/review'){
    only(input,['name','email','startsAt']);const payload=meetingInput(input),settings=getBookingSettings(db),day=toZonedISO(payload.startsAt,settings.timezone).slice(0,10);
    const available=await bookingService.slots({from:day,to:day}),slot=available.slots.find(slot=>slot.startsAt===payload.startsAt);
    if(!slot)fail('That time is no longer available. Choose another time.',409);
    const nonce=crypto.randomBytes(32).toString('base64url'),createdAt=Date.now(),expiresAt=createdAt+REVIEW_TTL;
    db.prepare("INSERT INTO booking_guest_reviews VALUES(?,?,'review',NULL,?,?)").run(hash(nonce),hash(JSON.stringify(payload)),createdAt,expiresAt);
    json(res,200,{nonce,expiresAt,title:settings.title,timezone:settings.timezone,slot:{startsAt:slot.startsAt,endsAt:slot.endsAt},contact:{name:payload.name,email:payload.email}});return;
   }
   if(pathname==='/guest/reserve'){const result=await reserve(input);json(res,result.replayed?200:201,result);return;}
   only(input,['id','token']);
   if(pathname==='/guest/confirmation'){const booking=getBookingForGuest(db,input);json(res,200,{booking:safeBooking(booking),title:getBookingSettings(db).title,invitationSent:false,calendarFileAvailable:true});return;}
   if(pathname==='/guest/cancel'){const result=await bookingService.cancel(input);json(res,200,{booking:safeBooking(result.booking)});return;}
   const bytes=bookingCalendarFile(db,input);res.writeHead(200,{...HEADERS,'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="meeting.ics"'});res.end(bytes);
  }catch(error){
   if(res.headersSent){res.destroy();return;}
   const known=error instanceof GuestError||error instanceof BookingError,status=known?error.status:503;
   if(status===413)res.setHeader('Connection','close');
   json(res,status,{error:known?error.message:'Booking is temporarily unavailable. Please try again later.',...(error instanceof GuestError?error.extra:{})});
  }
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=24;server.maxConnections=64;
 return server;
}
/** Always binds IPv4 loopback. Publication is a separate, owner-approved action. */
export function listenBookingGuest(server,{port=7780,host}={}){
 if(host!==undefined&&host!=='127.0.0.1')fail('The guest listener may bind only to 127.0.0.1.',500);
 if(!Number.isInteger(port)||port<0||port>65535)fail('Choose a valid local booking port.',500);
 return new Promise((resolve,reject)=>{const error=value=>{server.removeListener('listening',ready);reject(value);};const ready=()=>{server.removeListener('error',error);resolve(server.address());};server.once('error',error);server.once('listening',ready);server.listen(port,'127.0.0.1');});
}
