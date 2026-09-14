import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {extractDocument,previewDocument,migrateDocuments,commitDocument,getDocumentReview,listDocumentReceipts} from '../core/documents.mjs';
import {DatabaseSync} from 'node:sqlite';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import PDFDocument from 'pdfkit';
import * as finance from '../core/finance.mjs';
import * as health from '../core/health.mjs';
import {installDom,text as domText,findButton,settle} from './helpers/ui-dom.mjs';
const upload={filename:'../../sensitive.pdf',base64:Buffer.from('%PDF-1.7\nSynthetic fixture').toString('base64')};
const config={model:{protocol:'openai',baseUrl:'http://127.0.0.1:11434/v1',model:'nemotron-3-nano:30b',keyRef:null,maxTokens:16384}};
const raw='2026-09-10 Coffee supplies -12.34 USD\nInvoice A-12 Total 100.00 USD';
test('PDF extraction uses fixed local paths, preserves all readable text and removes private temporary files',async()=>{
 let directory;const calls=[];
 const result=await extractDocument(upload,{run:async(command,args)=>{calls.push(command);directory=path.dirname(args.find(x=>x.endsWith('.pdf')));if(process.platform!=='win32')assert.equal((await fs.stat(directory)).mode&0o777,0o700);assert.equal(path.basename(args.find(x=>x.endsWith('.pdf'))),'source.pdf');return {stdout:command==='pdfinfo'?'Pages: 2\n':`${raw} page ${args[1]}`};}});
 assert.deepEqual(calls,['pdfinfo','pdftotext','pdftotext']);assert.equal(result.text,`${raw} page 1\n\f\n${raw} page 2`);assert.equal(result.pageTexts[1].page,2);assert.equal(result.pageTexts[1].text,`${raw} page 2`);assert.equal(result.filename,'sensitive.pdf');assert.equal(result.pages,2);assert.equal(result.ocr,false);assert.match(result.digest,/^[a-f0-9]{64}$/);
 await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});
test('invalid formats, oversized documents, page limits and extractor failures refuse a partial import',async()=>{
 let called=false;await assert.rejects(extractDocument({base64:'not base64'},{run:async()=>{called=true;}}),/Choose a PDF/);assert.equal(called,false);
 await assert.rejects(extractDocument({base64:Buffer.from('not a document').toString('base64')}),/Only PDF/);
 let directory;await assert.rejects(extractDocument(upload,{run:async(command,args)=>{directory=path.dirname(args[0]);return {stdout:'Pages: 99\n'};}}),/1–12 pages/);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
 await assert.rejects(extractDocument(upload,{run:async command=>({stdout:command==='pdfinfo'?'Pages: 1':'x'.repeat(60001)})}),/too much text/);
});
test('scanned PDF pages are OCRed locally in page order and cleaned after cancellation',async()=>{
 const calls=[];let directory;
 const result=await extractDocument(upload,{run:async(command,args)=>{
  calls.push(command);
  if(command==='pdfinfo'){directory=path.dirname(args[0]);return {stdout:'Pages: 2'};}
  if(command==='pdftotext')return {stdout:''};
  if(command==='pdftoppm'){assert.ok(args.includes('-singlefile'));return {stdout:''};}
  return {stdout:path.basename(args[0])+' extracted readable statement text'};
 }});
 assert.equal(result.ocr,true);assert.match(result.text,/page-1.*\npage-2/s);assert.equal(calls.filter(x=>x==='tesseract').length,2);assert.deepEqual(result.pageTexts.map(page=>page.page),[1,2]);
 const controller=new AbortController();await assert.rejects(extractDocument(upload,{signal:controller.signal,run:async(command,args)=>{directory=path.dirname(args.find(x=>x.endsWith('.pdf')));if(command==='pdfinfo')return {stdout:'Pages: 1'};controller.abort();return {stdout:raw};}}));await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});
test('statement extraction is a local, unsaved review with evidence and integer cents',async()=>{
 let sent;const result=await previewDocument({document:{text:raw,filename:'card.pdf',digest:'hash',pages:1},kind:'statement',config,complete:async options=>{sent=options;return {text:JSON.stringify({rows:[{date:'2026-09-10',description:'Coffee supplies',amountCents:-1234,currency:'USD',evidence:'Coffee supplies -12.34 USD'}],warnings:[]}),stopReason:'stop'};}});
 assert.equal(sent.reasoningEffort,'none');assert.equal(sent.json,true);assert.match(sent.messages[0].content,/ZELOS-UNTRUSTED/);assert.equal(result.saved,false);assert.equal(result.rows[0].amountCents,-1234);assert.equal(result.rows[0].needsReview,true);assert.equal(result.rows[0].evidenceFound,true);
});
test('unsupported remote models and incomplete responses never become imported records',async()=>{
 let calls=0;const complete=async()=>{calls++;return {text:'{}'};};
 await assert.rejects(previewDocument({document:{text:raw},kind:'labs',config:{model:{...config.model,baseUrl:'https://api.example.com'}},complete}),/local model/);assert.equal(calls,0);
 await assert.rejects(previewDocument({document:{text:raw},kind:'labs',config,complete:async()=>({text:'{"rows":[]}',stopReason:'length'})}),/limit/);
 await assert.rejects(previewDocument({document:{text:raw},kind:'labs',config,complete:async()=>({text:'not JSON'})}),/unreadable preview/);
});
test('unverified evidence and malformed financial values stay null for explicit manual review',async()=>{
 const result=await previewDocument({document:{text:raw},kind:'statement',config,complete:async()=>({text:JSON.stringify({rows:[{date:'2026-02-31',description:'invented',amountCents:10000,currency:'usd',evidence:'not in the file'}]})})});
 assert.equal(result.rows[0].amountCents,null);assert.equal(result.rows[0].date,null);assert.equal(result.rows[0].currency,null);assert.equal(result.rows[0].evidenceFound,false);
});
test('blood test extraction preserves units and ranges without saving diagnoses or extra model fields',async()=>{
 const text='2026-09-10 Glucose 90 mg/dL reference 70-99';
 const result=await previewDocument({document:{text},kind:'labs',config,complete:async()=>({text:JSON.stringify({rows:[{date:'2026-09-10',name:'Glucose',value:90,unit:'mg/dL',referenceLow:70,referenceHigh:99,evidence:text,diagnosis:'fabricated'}]})})});
 assert.equal(result.rows[0].value,90);assert.equal(result.rows[0].referenceHigh,99);assert.equal(result.rows[0].unit,'mg/dL');assert.equal('diagnosis' in result.rows[0],false);assert.equal(result.saved,false);
});

function database(t,filename=':memory:'){
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');finance.migrateFinance(db);health.migrateHealth(db);migrateDocuments(db);t.after(()=>db.close());
 const entity=finance.addEntity(db,{name:'Synthetic Studio',type:'company',defaultCurrency:'USD'});
 const account=finance.saveAccount(db,{entityId:entity.id,name:'Synthetic checking',type:'bank',currency:'USD'});
 return {db,entity,account};
}
const statementRow={date:'2026-09-10',description:'Coffee supplies',amountCents:-1234,currency:'USD',evidence:'Coffee supplies -12.34 USD'};
async function staged(db,{kind='statement',rows=[statementRow],text=raw,digest=crypto.createHash('sha256').update(text).digest('hex'),pageTexts=[{page:1,text,ocr:false}]}={}){
 return previewDocument({db,document:{text,digest,filename:`synthetic-${kind}.pdf`,pages:pageTexts.length,pageTexts,ocr:false},kind,config,complete:async()=>({text:JSON.stringify({rows,warnings:[]})})});
}
const payload=(f,preview,rows=preview.rows)=>({reviewId:preview.reviewId,reviewed:true,entityId:f.entity.id,accountId:f.account.id,rows:rows.map(row=>({...row,selected:true}))});

test('document migration is idempotent inside an enclosing schema transaction',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('BEGIN');migrateDocuments(db);migrateDocuments(db);db.exec('COMMIT');assert.equal(listDocumentReceipts(db).receipts.length,0);}finally{db.close();}
});

test('mixed PDF pages retain text pages and apply OCR only where required',async()=>{
 const calls=[];const result=await extractDocument(upload,{run:async(command,args)=>{
  calls.push([command,args]);if(command==='pdfinfo')return {stdout:'Pages: 2'};
  if(command==='pdftotext')return {stdout:args[1]==='1'?raw:''};
  if(command==='pdftoppm')return {stdout:''};
  return {stdout:'A second page with readable synthetic invoice text'};
 }});
 assert.equal(result.pageTexts[0].text,raw);assert.equal(result.pageTexts[0].ocr,false);assert.equal(result.pageTexts[1].ocr,true);
 assert.equal(calls.filter(([command])=>command==='tesseract').length,1);
 assert.equal(calls.find(([command])=>command==='pdftoppm')[1][1],'2');
});

test('oversized raster dimensions are rejected before starting the OCR reader',async()=>{
 const bytes=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(10000,16);bytes.writeUInt32BE(10000,20);
 let called=false;await assert.rejects(extractDocument({filename:'large.png',base64:bytes.toString('base64')},{run:async()=>{called=true;}}),/25 million pixels/);assert.equal(called,false);
});

test('installed local Poppler extracts a real two-page synthetic PDF with page boundaries',async t=>{
 if(spawnSync('pdfinfo',['-v'],{timeout:5000}).error?.code==='ENOENT'||spawnSync('pdftotext',['-v'],{timeout:5000}).error?.code==='ENOENT'){t.skip('Local Poppler is not installed in this test environment.');return;}
 const pdf=new PDFDocument(),chunks=[];const done=new Promise((resolve,reject)=>{pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',resolve);pdf.on('error',reject);});
 pdf.text('Synthetic first-page statement: 2026-09-10 Coffee supplies -12.34 USD');pdf.addPage();pdf.text('Synthetic second-page invoice: INV-TEST total 100.00 USD, due 2026-09-30.');pdf.end();await done;
 const extracted=await extractDocument({filename:'synthetic-native.pdf',base64:Buffer.concat(chunks).toString('base64')});
 assert.equal(extracted.pages,2);assert.equal(extracted.ocr,false);assert.match(extracted.pageTexts[0].text,/first-page statement/);assert.match(extracted.pageTexts[1].text,/second-page invoice/);assert.doesNotMatch(extracted.pageTexts[0].text,/second-page/);
});

test('evidence pages are verified from excerpts instead of trusting model page claims',async()=>{
 const pages=[{page:1,text:'A cover page with synthetic introductory information'},{page:2,text:raw}];
 const result=await previewDocument({document:{text:pages.map(page=>page.text).join('\n'),pageTexts:pages,pages:2},kind:'statement',config,
  complete:async()=>({text:JSON.stringify({rows:[{...statementRow,page:1}]})})});
 assert.deepEqual(result.rows[0].evidencePages,[2]);assert.equal(result.rows[0].evidenceFound,true);
});

test('staging a preview creates no financial or health record and reuses source identity',async t=>{
 const f=database(t),preview=await staged(f.db);
 assert.ok(preview.reviewId);assert.equal(preview.saved,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,0);assert.equal(health.getHealth(f.db).labs.length,0);
 let called=false;const again=await previewDocument({db:f.db,document:{text:raw,digest:preview.digest},kind:'statement',config,complete:async()=>{called=true;}});
 assert.equal(called,false);assert.equal(again.reviewId,preview.reviewId);assert.equal(again.pageTexts[0].text,raw);
});

test('a reviewed statement saves exact signed cents with immutable source evidence and receipt',async t=>{
 const f=database(t),preview=await staged(f.db),input=payload(f,preview);
 input.rows[0]={...input.rows[0],description:'Coffee and paper',amountCents:-29,category:'Office',id:'an-existing-record',evidence:'forged',evidencePages:[99]};
 const receipt=commitDocument(f.db,input);
 assert.equal(receipt.imported,1);assert.equal(receipt.duplicates,0);assert.equal(receipt.saved,true);
 const row=f.db.prepare('SELECT * FROM finance_transactions').get();assert.equal(row.amount_cents,-29);assert.equal(row.description,'Coffee and paper');assert.equal(row.category,'Office');assert.equal(row.status,'confirmed');assert.notEqual(row.id,'an-existing-record');
 const evidence=JSON.parse(f.db.prepare('SELECT evidence_json FROM document_records').get().evidence_json);
 assert.equal(evidence.evidence,statementRow.evidence);assert.deepEqual(evidence.evidencePages,[1]);assert.equal(evidence.digest,preview.digest);
 assert.equal(listDocumentReceipts(f.db).receipts[0].receiptId,receipt.receiptId);assert.equal(getDocumentReview(f.db,preview.reviewId).committed[0].id,row.id);
});

test('review confirmation, selection, source indices, dates and exact money values are mandatory',async t=>{
 const f=database(t),preview=await staged(f.db),input=payload(f,preview);
 for(const change of [{reviewed:false},{reviewId:'missing'},{rows:[]},{rows:[{...input.rows[0],selected:false}]},{rows:[{...input.rows[0],index:12}]},{rows:[input.rows[0],input.rows[0]]},
  {rows:[{...input.rows[0],date:null}]},{rows:[{...input.rows[0],amountCents:null}]},{rows:[{...input.rows[0],amountCents:-12.34}]},{rows:[{...input.rows[0],currency:''}]}])assert.throws(()=>commitDocument(f.db,{...input,...change}));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,0);assert.equal(listDocumentReceipts(f.db).receipts.length,0);
});

test('retry returns the same receipt and changed details or target cannot duplicate a saved row',async t=>{
 const f=database(t),preview=await staged(f.db),input=payload(f,preview),first=commitDocument(f.db,input),second=commitDocument(f.db,input);
 assert.equal(second.receiptId,first.receiptId);assert.equal(second.replayed,true);
 assert.throws(()=>commitDocument(f.db,{...input,rows:[{...input.rows[0],amountCents:-500}]}),error=>error.status===409);
 const other=finance.saveAccount(f.db,{entityId:f.entity.id,name:'Other account',currency:'USD'});
 assert.throws(()=>commitDocument(f.db,{...input,accountId:other.id}),error=>error.status===409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,1);assert.equal(listDocumentReceipts(f.db).receipts.length,1);
});

test('selected rows can be saved in batches while identical legitimate source rows remain separate',async t=>{
 const f=database(t),preview=await staged(f.db,{rows:[statementRow,statementRow]}),input=payload(f,preview);
 assert.equal(commitDocument(f.db,{...input,rows:[input.rows[0]]}).imported,1);
 const receipt=commitDocument(f.db,input);assert.equal(receipt.imported,1);assert.equal(receipt.duplicates,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,2);
 assert.equal(commitDocument(f.db,input).receiptId,receipt.receiptId);
});

test('finance validation failure rolls back every record, source marker and receipt',async t=>{
 const f=database(t),preview=await staged(f.db,{rows:[statementRow,statementRow]}),input=payload(f,preview);
 input.rows[1].currency='EUR';assert.throws(()=>commitDocument(f.db,input),/same currency/);
 for(const table of ['finance_transactions','document_records','document_commits'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 input.rows[1].currency='USD';assert.equal(commitDocument(f.db,input).imported,2);
});

test('statements must bind the account to the selected company and preserve transfer/refund signs',async t=>{
 const f=database(t),preview=await staged(f.db,{rows:[statementRow,statementRow]}),input=payload(f,preview);
 const other=finance.addEntity(f.db,{name:'Another company'});
 assert.throws(()=>commitDocument(f.db,{...input,entityId:other.id}),/workspace/);
 input.rows[0].kind='transfer';input.rows[0].amountCents=-12000;input.rows[1].amountCents=29;
 commitDocument(f.db,input);const rows=finance.getFinance(f.db,{month:'2026-09'}).transactions;
 assert.equal(rows.find(row=>row.kind==='transfer').amountCents,-12000);assert.equal(rows.find(row=>row.kind==='income').amountCents,29);
});

test('invoices require an explicit direction and save unpaid without a cash transaction',async t=>{
 const f=database(t),row={number:'A-12',counterparty:'Fictional supplier',description:'Materials',issueDate:'2026-09-01',dueDate:'2026-09-30',amountCents:10000,currency:'USD',evidence:'Invoice A-12 Total 100.00 USD'};
 const preview=await staged(f.db,{kind:'invoice',rows:[row]}),input=payload(f,preview);
 assert.throws(()=>commitDocument(f.db,input),/owe/);
 const receipt=commitDocument(f.db,{...input,direction:'payable'});assert.equal(receipt.records[0].kind,'invoice');
 const invoice=finance.getFinance(f.db,{month:'2026-09'}).invoices[0];assert.equal(invoice.status,'unpaid');assert.equal(invoice.direction,'payable');assert.equal(invoice.amountCents,10000);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,0);
});

test('lab imports preserve edited qualitative results, units, ranges and source without conclusions',async t=>{
 const f=database(t),text='2026-09-10 Example antibody <5 units range less than 10';
 const preview=await staged(f.db,{kind:'labs',text,rows:[{date:'2026-09-10',name:'Example antibody',value:null,unit:'units',referenceLow:null,referenceHigh:null,referenceText:'less than 10',evidence:text}]}),input=payload(f,preview);
 assert.throws(()=>commitDocument(f.db,input),/exact result/);
 input.rows[0].value='<5';input.rows[0].lab='Synthetic laboratory';input.rows[0].diagnosis='unwanted conclusion';
 const receipt=commitDocument(f.db,input),lab=health.getHealth(f.db).labs[0];
 assert.equal(receipt.records[0].kind,'lab');assert.equal(lab.value,'<5');assert.equal(lab.unit,'units');assert.equal(lab.referenceText,'less than 10');assert.match(lab.documentNote,/Source pages: 1/);assert.match(lab.documentNote,/<5 units/);assert.equal('diagnosis' in lab,false);
});

test('reopened databases keep document dedupe and return the original import receipt',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zelos-document-restart-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'records.sqlite');let db=new DatabaseSync(file);
 finance.migrateFinance(db);health.migrateHealth(db);migrateDocuments(db);
 const entity=finance.addEntity(db,{name:'Restart Studio'}),account=finance.saveAccount(db,{entityId:entity.id,name:'Checking'});
 const preview=await staged(db),input=payload({entity,account},preview),first=commitDocument(db,input);db.close();
 db=new DatabaseSync(file);try{migrateDocuments(db);const retry=commitDocument(db,input);assert.equal(retry.receiptId,first.receiptId);assert.equal(retry.replayed,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,1);}finally{db.close();}
});

let uiId=0;
async function uiFixture(t,{uncertain=false,kind='statement'}={}){
 const doc=installDom(t),f=database(t),{api}=await import('../ui/lib/api.js'),calls=[];
 const handlers={finance:async()=>finance.getFinance(f.db,{month:'2026-09'}),documentReceipts:async()=>listDocumentReceipts(f.db),
  previewDocument:async input=>staged(f.db,{kind:input.kind,rows:[{...statementRow,...(uncertain?{amountCents:null,currency:null}:{}),description:'<img onerror=alert(1)>'}]}),
  commitDocument:async input=>commitDocument(f.db,input)};
 for(const [key,handler] of Object.entries(handlers)){const previous=api[key];api[key]=(...args)=>{calls.push({key,input:args[0]});return handlers[key](...args);};t.after(()=>{api[key]=previous;});}
 const module=await import(`../ui/views/documents.js?test=${++uiId}`),root=doc.body.appendChild(module.renderDocuments());await settle();
 const click=label=>{const button=findButton(root,label);assert.ok(button,label);button.click();};
 const input=(label,value)=>{const node=root.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);node.value=value;node.fire(node.tag==='select'?'change':'input');};
 const check=(label,value)=>{const node=root.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);node.checked=value;node.fire('change');};
 const uploadFile=async()=>{const node=root.querySelector('[aria-label="Document file"]'),bytes=new TextEncoder().encode('%PDF-1.7 Synthetic fixture');node.files=[{name:'example.pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer}];node.fire('change');click('Read document');await settle();};
 if(kind!=='statement')input('Document type',kind);
 return {...f,doc,root,module,calls,handlers,click,input,check,uploadFile};
}

test('document UI stages text safely and saves only selected, explicitly reviewed edited records',async t=>{
 const f=await uiFixture(t);await f.uploadFile();
 assert.match(domText(f.root),/Nothing is imported until you save selected rows/);assert.match(f.root.querySelector('[aria-label="Row 1 Description"]').value,/<img onerror=alert/);
 assert.equal(f.root.querySelector('img'),null);assert.equal(f.calls.filter(call=>call.key==='commitDocument').length,0);
 assert.equal(findButton(f.root,'Save reviewed records').disabled,true);
 f.input('Document account',f.account.id);f.check('Save row 1',true);f.input('Row 1 Signed amount','-0.29');f.input('Row 1 Category','Office');f.click('Save reviewed records');await settle();
 assert.match(domText(f.root.querySelector('[role="alert"]')),/review confirmation/);assert.equal(f.calls.filter(call=>call.key==='commitDocument').length,0);
 f.check('I reviewed the selected rows',true);f.click('Save reviewed records');await settle();
 assert.match(domText(f.root),/1 record imported/);assert.equal(f.db.prepare('SELECT amount_cents FROM finance_transactions').get().amount_cents,-29);
 assert.ok(f.root.querySelectorAll('a').some(link=>link.getAttribute('href')==='#/finance'));
 assert.equal(findButton(f.root,'Save reviewed records').disabled,true);assert.ok(f.root.querySelector('[aria-label="Row 1 already saved"]'));
 await f.uploadFile();assert.equal(f.root.querySelector('[aria-label="Row 1 Signed amount"]').value,'-0.29');assert.equal(f.root.querySelector('[aria-label="Row 1 Category"]').value,'Office');assert.equal(findButton(f.root,'Save reviewed records').disabled,true);
});

test('document UI keeps uncertain amounts blank and resets confirmation after edits',async t=>{
 const f=await uiFixture(t,{uncertain:true});await f.uploadFile();f.input('Document account',f.account.id);f.check('Save row 1',true);
 assert.equal(f.root.querySelector('[aria-label="Row 1 Signed amount"]').value,'');
 f.check('I reviewed the selected rows',true);f.click('Save reviewed records');await settle();assert.match(domText(f.root.querySelector('[role="alert"]')),/each amount/);
 f.input('Row 1 Signed amount','-12.34');f.input('Row 1 Currency','usd');assert.equal(f.root.querySelector('[aria-label="I reviewed the selected rows"]').checked,false);
 f.check('I reviewed the selected rows',true);f.click('Save reviewed records');await settle();assert.equal(f.db.prepare('SELECT currency FROM finance_transactions').get().currency,'USD');
});

test('failed document save keeps reviewed edits for a safe identical retry',async t=>{
 const f=await uiFixture(t);await f.uploadFile();f.input('Document account',f.account.id);f.check('Save row 1',true);f.check('I reviewed the selected rows',true);
 const original=f.handlers.commitDocument;let first=true;f.handlers.commitDocument=async input=>{const result=await original(input);if(first){first=false;throw new Error('Synthetic lost response');}return result;};
 f.click('Save reviewed records');await settle();assert.match(domText(f.root),/Synthetic lost response/);assert.equal(f.root.querySelector('[aria-label="I reviewed the selected rows"]').checked,true);
 f.click('Save reviewed records');await settle();assert.match(domText(f.root),/Saved import confirmed/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_transactions').get().n,1);
});

test('document navigation selects the requested import type but preserves an active review and receipt refresh edits',async t=>{
 const f=await uiFixture(t);f.module.renderDocuments({sub:'labs'});assert.equal(f.root.querySelector('[aria-label="Document type"]').value,'labs');
 f.module.renderDocuments({sub:'statement'});await f.uploadFile();f.input('Row 1 Description','My carefully reviewed description');
 f.module.renderDocuments({sub:'labs'});assert.equal(f.root.querySelector('[aria-label="Document type"]').value,'statement');
 f.click('Refresh receipts');await settle();assert.equal(f.root.querySelector('[aria-label="Row 1 Description"]').value,'My carefully reviewed description');
 assert.equal(f.calls.filter(call=>call.key==='commitDocument').length,0);
});
