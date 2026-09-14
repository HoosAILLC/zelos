import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {lockHolderState} from '../core/home-lock.mjs';
import {acquireMaintenance,MAINTENANCE_FILE} from '../core/data-lease.mjs';

const now=Date.parse('2026-09-14T12:00:00Z');
const fresh={pid:process.pid+1000,uid:null,startedAt:'2026-09-14T11:30:00Z'};

test('Windows ownership unknown plus denied process access is not proof of a dead holder',()=>{
 assert.equal(lockHolderState(fresh,{now,bootedAt:now-3600000,uid:null,signal:()=> 'denied'}).held,true);
 assert.equal(lockHolderState(fresh,{now,bootedAt:now-3600000,uid:null,signal:()=> 'gone'}).held,false);
 assert.equal(lockHolderState({...fresh,startedAt:'2026-09-13T12:00:00Z'},{now,bootedAt:now-3600000,uid:null,signal:()=> 'denied'}).held,false);
});

test('maintenance requires proof of process death even when advisory ownership heuristics disagree',()=>{
 for(const uid of [null,501])assert.equal(lockHolderState({...fresh,uid},{now,bootedAt:now-3600000,uid,signal:()=> 'denied',strict:true}).held,true);
});

for(const code of ['EPERM','EACCES','ENOSYS'])test(`maintenance preserves a fresh marker when the platform cannot inspect its process (${code})`,t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-platform-lease-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const markers=path.join(home,MAINTENANCE_FILE);fs.mkdirSync(markers);
 const id=crypto.randomUUID(),file=path.join(markers,`${id}.json`);
 fs.writeFileSync(file,JSON.stringify({...fresh,id,startedAt:new Date().toISOString()}));
 t.mock.method(os,'uptime',()=>3600);
 t.mock.method(process,'kill',()=>{throw Object.assign(new Error('Process access unavailable'),{code});});
 assert.throws(()=>acquireMaintenance({home}),{code:'ZELOS_DATA_BUSY'});
 assert.deepEqual(fs.readdirSync(markers),[`${id}.json`]);
});

test('maintenance still reclaims a process the operating system proves has exited',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-platform-dead-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const markers=path.join(home,MAINTENANCE_FILE);fs.mkdirSync(markers);
 const id=crypto.randomUUID();fs.writeFileSync(path.join(markers,`${id}.json`),JSON.stringify({...fresh,id,startedAt:new Date().toISOString()}));
 t.mock.method(os,'uptime',()=>3600);t.mock.method(process,'kill',()=>{throw Object.assign(new Error('No such process'),{code:'ESRCH'});});
 const lease=acquireMaintenance({home});assert.equal(fs.existsSync(path.join(markers,`${id}.json`)),false);lease.release();assert.equal(fs.readdirSync(markers).length,0);
});
