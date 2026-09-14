/** Daily authenticated encrypted recovery copies, held on the local machine. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBackup, stageBackup } from './backup.mjs';
import { getKV, setKV } from './db.mjs';

const MAGIC=Buffer.from('ZELOS-ENCRYPTED-1\n'),CHUNK=256*1024;
export const BACKUP_ENABLED_KEY='backup.automatic.enabled';
export class AutomaticBackupError extends Error { constructor(message,status=409){super(message);this.status=status;} }
const regular=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new AutomaticBackupError('A backup file is not a regular private file.');return st;};
function directory(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new AutomaticBackupError('The backup folder must be a local directory.');fs.chmodSync(dir,0o700);}
const names=home=>{const dir=path.join(home,'backups','automatic');return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^\d{8}T\d{9}Z-[a-f0-9-]{36}\.zelos-encrypted$/.test(n)).sort().reverse():[];};
function keyFor(home){
  const file=path.join(home,'.automatic-backup-key');
  if(!fs.existsSync(file)){
    if(names(home).length)throw new AutomaticBackupError('The recovery key is missing. Existing backups were preserved.');
    fs.writeFileSync(file,crypto.randomBytes(32),{mode:0o600,flag:'wx'});
  }
  if(regular(file).size!==32)throw new AutomaticBackupError('The recovery key is damaged. Existing backups were preserved.');
  fs.chmodSync(file,0o600);return fs.readFileSync(file);
}
function encrypt(source,destination,key){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
  const input=fs.openSync(source,'r'),output=fs.openSync(destination,'wx',0o600),bytes=Buffer.alloc(CHUNK);
  try{
    fs.writeFileSync(output,MAGIC);fs.writeFileSync(output,iv);
    for(;;){const n=fs.readSync(input,bytes,0,bytes.length,null);if(!n)break;fs.writeFileSync(output,cipher.update(bytes.subarray(0,n)));}
    fs.writeFileSync(output,cipher.final());fs.writeFileSync(output,cipher.getAuthTag());fs.fsyncSync(output);
  }finally{fs.closeSync(input);fs.closeSync(output);}
}
/** Decrypt only into an owner-only staging directory, authenticate, then validate
 * the original backup format. This does not replace any live data. */
export function stageEncryptedBackup({home,source,keyFile=path.join(home,'.automatic-backup-key')}) {
  const stat=regular(source);if(regular(keyFile).size!==32)throw new AutomaticBackupError('The recovery key is invalid.');
  const scratch=fs.mkdtempSync(path.join(home,'.decrypt-backup-'));fs.chmodSync(scratch,0o700);
  const plain=path.join(scratch,'verified.zelos-backup');
  let input,output;
  try {
    if(stat.size<MAGIC.length+28)throw new Error('Truncated backup');
    input=fs.openSync(source,'r');const header=Buffer.alloc(MAGIC.length+12);fs.readSync(input,header,0,header.length,0);
    if(!header.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Unknown encrypted backup');
    const tag=Buffer.alloc(16);fs.readSync(input,tag,0,16,stat.size-16);
    const decipher=crypto.createDecipheriv('aes-256-gcm',fs.readFileSync(keyFile),header.subarray(MAGIC.length));decipher.setAAD(MAGIC);decipher.setAuthTag(tag);
    output=fs.openSync(plain,'wx',0o600);const bytes=Buffer.alloc(CHUNK);let offset=header.length;
    while(offset<stat.size-16){const n=fs.readSync(input,bytes,0,Math.min(bytes.length,stat.size-16-offset),offset);if(!n)throw new Error('Truncated backup');offset+=n;fs.writeFileSync(output,decipher.update(bytes.subarray(0,n)));}
    fs.writeFileSync(output,decipher.final());fs.fsyncSync(output);fs.closeSync(output);output=undefined;
    fs.closeSync(input);input=undefined;
    return stageBackup({home,source:plain});
  }catch{throw new AutomaticBackupError('The encrypted backup or recovery key could not be verified. Live data was not changed.');}
  finally{if(input!==undefined)fs.closeSync(input);if(output!==undefined)fs.closeSync(output);fs.rmSync(scratch,{recursive:true,force:true});}
}
export function automaticBackupStatus(db,home) {
  let last=null;try{last=JSON.parse(getKV(db,'backup.automatic.last'));}catch{}
  return {enabled:getKV(db,BACKUP_ENABLED_KEY)==='true',last,
    copies:names(home).length,retention:7,location:'On the computer running Zelos',
    keyPresent:fs.existsSync(path.join(home,'.automatic-backup-key'))};
}
export function saveAutomaticBackupSettings(db,home,input) {
  if(typeof input?.enabled!=='boolean')throw new AutomaticBackupError('Choose whether daily backups should run.',400);
  setKV(db,BACKUP_ENABLED_KEY,String(input.enabled));return automaticBackupStatus(db,home);
}
export function runAutomaticBackup({db,home,config,appVersion,now=new Date(),force=false}) {
  const previous=automaticBackupStatus(db,home),at=new Date(now).toISOString();
  if(!force && (!previous.enabled || previous.last && new Date(now)-Date.parse(previous.last.at)<(previous.last.ok?86400000:3600000)))return previous;
  const dir=path.join(home,'backups');directory(dir);directory(path.join(dir,'automatic'));
  const dest=path.join(dir,'automatic',`${at.replace(/[-:.]/g,'')}-${crypto.randomUUID()}.zelos-encrypted`);
  const plain=path.join(dir,`.automatic-${crypto.randomUUID()}.zelos-backup`),partial=`${dest}.partial`;
  try {
    const key=keyFor(home);
    createBackup({home,db,destination:plain,config,appVersion,now});
    encrypt(plain,partial,key);
    const staged=stageEncryptedBackup({home,source:partial});staged.cleanup();
    fs.renameSync(partial,dest);
    const last={ok:true,at,filename:path.basename(dest),bytes:regular(dest).size,verified:true};
    setKV(db,'backup.automatic.last',JSON.stringify(last));
    // Retire only recognized older copies, after this replacement was verified.
    for(const name of names(home).slice(7)){const file=path.join(dir,'automatic',name);regular(file);fs.unlinkSync(file);}
    return automaticBackupStatus(db,home);
  }catch(error){
    setKV(db,'backup.automatic.last',JSON.stringify({ok:false,at,error:'The local backup could not be verified. Previous copies were kept.'}));
    throw new AutomaticBackupError('The local backup could not finish. Previous copies were kept.');
  }finally{fs.rmSync(plain,{force:true});fs.rmSync(partial,{force:true});}
}
