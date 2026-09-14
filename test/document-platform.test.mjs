import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentToolCandidates,runDocumentCommand,extractDocument} from '../core/documents.mjs';

const missing=()=>Object.assign(new Error('Executable unavailable'),{code:'ENOENT'});
const upload={filename:'C:\\Users\\Example Person\\Documents\\statement.pdf',base64:Buffer.from('%PDF-1.7\nSynthetic fixture').toString('base64')};

test('macOS Finder launch locates both Homebrew installation prefixes without requiring shell PATH',async()=>{
 for(const prefix of ['/opt/homebrew/bin','/usr/local/bin']){
  const calls=[],args=['-f','1','/tmp/statement with spaces;$(touch ignored).pdf','-'];
  const result=await runDocumentCommand('pdftotext',args,{platform:'darwin',env:{PATH:'/usr/bin:/bin'},home:'/Users/Example Person',executeCommand:async(file,actual,options)=>{
   calls.push(file);assert.equal(actual,args);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
   if(file!==`${prefix}/pdftotext`)throw missing();return {stdout:'Readable statement'};
  }});
  assert.equal(result.stdout,'Readable statement');assert.equal(calls.at(-1),`${prefix}/pdftotext`);
 }
});

test('Windows OCR finds Program Files as one executable path and uses executable extensions',async()=>{
 const env={ProgramFiles:'C:\\Program Files',LOCALAPPDATA:'C:\\Users\\Example Person\\AppData\\Local'},calls=[];
 const result=await runDocumentCommand('tesseract',['C:\\Temp\\scan with spaces.png','stdout'],{platform:'win32',env,home:'C:\\Users\\Example Person',executeCommand:async(file,args,options)=>{
  calls.push(file);assert.equal(options.env,env);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  if(file!=='C:\\Program Files\\Tesseract-OCR\\tesseract.exe')throw missing();return {stdout:'Readable Windows scan'};
 }});
 assert.equal(result.stdout,'Readable Windows scan');assert.equal(calls[0],'tesseract.exe');assert.ok(calls.every(file=>!file.includes('/usr/')&&!file.includes('/opt/')));
 const pdf=documentToolCandidates('pdfinfo',{platform:'win32',env,home:'C:\\Users\\Example Person'});
 assert.ok(pdf.includes('C:\\Program Files\\poppler\\Library\\bin\\pdfinfo.exe'));
});

test('dependency errors name the missing component without assuming Spark hardware',async()=>{
 for(const [command,component] of [['pdfinfo','Poppler'],['tesseract','Tesseract OCR']]){
  await assert.rejects(runDocumentCommand(command,[],{platform:'win32',env:{},home:'C:\\Example',executeCommand:async()=>{throw missing();}}),error=>error.status===409&&error.message.includes(component)&&error.message.includes('PATH')&&!error.message.includes('Spark'));
 }
});

test('reader failures and cancellation do not execute another installation or a shell',async()=>{
 let calls=0;await assert.rejects(runDocumentCommand('pdfinfo',[],{platform:'darwin',executeCommand:async()=>{calls++;throw Object.assign(new Error('Broken PDF'),{code:1});}}),error=>error.status===422);assert.equal(calls,1);
 const controller=new AbortController();controller.abort(new Error('Cancelled by owner'));
 await assert.rejects(runDocumentCommand('pdfinfo',[],{signal:controller.signal,executeCommand:async()=>{assert.fail('Cancelled reader ran');}}),/Cancelled by owner/);
 assert.throws(()=>documentToolCandidates('cmd.exe'),/not supported/);
 assert.deepEqual(documentToolCandidates('tesseract',{platform:'freebsd',env:{},home:'/home/example'}),['tesseract']);
});

test('uploaded Windows filenames become basenames on every server platform',async()=>{
 const result=await extractDocument(upload,{run:async command=>({stdout:command==='pdfinfo'?'Pages: 1':'A complete readable synthetic statement.'})});
 assert.equal(result.filename,'statement.pdf');
});

test('temporary document directories are removed if permission setup fails',async t=>{
 let directory;const chmod=fs.chmod;
 t.mock.method(fs,'chmod',async(file,mode)=>{if(path.basename(file).startsWith('zelos-document-')){directory=file;throw Object.assign(new Error('Permission setup refused'),{code:'EPERM'});}return chmod(file,mode);});
 await assert.rejects(extractDocument(upload,{run:async()=>{assert.fail('Reader ran after failed setup');}}),/Permission setup refused/);
 await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});
