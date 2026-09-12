/** Upload -> local extraction -> editable review -> explicit, receipted save. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { disclosure } from '../lib/workspace.js';
const view={root:null,finance:null,receipts:[],file:null,kind:'statement',entityId:'',accountId:'',direction:'',preview:null,rows:[],ack:false,busy:'',error:'',notice:'',receipt:null,request:0,controller:null,expandRows:0,refreshing:false};
const note=message=>el('p',{class:'documents-note',text:message});
const receiptDate=value=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const field=(label,node)=>el('label',{class:'documents-field'},[el('span',{text:label}),node]);
const entities=()=>view.finance?.entities||[];
function invalidate(){view.ack=false;const ack=view.root?.querySelector('[aria-label="I reviewed the selected rows"]');if(ack)ack.checked=false;}
function input(label,value,change,props={}){
 const node=el('input',{class:'input','aria-label':label,value:value??'',disabled:!!view.busy,...props});
 node.addEventListener('input',()=>{change(node.value);invalidate();});return node;
}
function select(label,value,options,change){
 const node=el('select',{class:'input','aria-label':label,disabled:!!view.busy},options.map(([value,text])=>el('option',{value,text})));
 node.value=value??'';node.addEventListener('change',()=>{change(node.value);invalidate();});return node;
}
function checkbox(label,checked,change,disabled=false){
 const node=el('input',{type:'checkbox','aria-label':label,disabled:disabled||!!view.busy});node.checked=checked;
 node.addEventListener('change',()=>change(node.checked));return el('label',{class:'documents-check'},[node,el('span',{text:label})]);
}
export function documentAmountCents(raw,{positive=false}={}){
 const value=String(raw).trim();if(!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Enter each amount with at most two decimal places. Use a minus sign for spending.');
 const sign=value.startsWith('-')?-1:1,[whole,fraction='']=value.replace(/^[+-]/,'').split('.');
 const cents=sign*(Number(whole)*100+Number(fraction.padEnd(2,'0')));
 if(!Number.isSafeInteger(cents)||Math.abs(cents)>1e12||positive&&cents<=0)throw new Error('Check the selected amount. Invoice totals must be positive.');return cents;
}
const optionalNumber=raw=>{if(raw==null||String(raw).trim()==='')return null;const value=Number(raw);if(!Number.isFinite(value))throw new Error('Reference ranges must be numeric or blank.');return value;};
export function documentCommitPayload({preview,rows,entityId,accountId,direction,ack}){
 if(!preview?.reviewId)throw new Error('Read a document before saving records.');
 if(!ack)throw new Error('Check the review confirmation before saving.');
 const selected=rows.filter(row=>row.selected&&!row.saved);
 if(!selected.length)throw new Error('Select at least one row to save.');
 if(preview.kind!=='labs'&&!entityId)throw new Error('Choose the workspace for these records.');
 if(preview.kind==='statement'&&!accountId)throw new Error('Choose the account for this statement.');
 if(preview.kind==='invoice'&&!['payable','receivable'].includes(direction))throw new Error('Choose whether you owe this invoice or are owed it.');
 return {reviewId:preview.reviewId,reviewed:true,...(preview.kind!=='labs'?{entityId}:{}),...(preview.kind==='statement'?{accountId}:{}),...(preview.kind==='invoice'?{direction}:{}),rows:selected.map(row=>{
  const result={index:row.index,selected:true};
  if(preview.kind==='statement')return {...result,date:row.date,description:row.description,amountCents:documentAmountCents(row.amount),currency:row.currency.trim().toUpperCase(),category:row.category||'Uncategorized',kind:row.kind||undefined};
  if(preview.kind==='invoice')return {...result,number:row.number,counterparty:row.counterparty,description:row.description,issueDate:row.issueDate,dueDate:row.dueDate,amountCents:documentAmountCents(row.amount,{positive:true}),currency:row.currency.trim().toUpperCase()};
  return {...result,date:row.date,name:row.name,value:row.value,unit:row.unit,referenceLow:optionalNumber(row.referenceLow),referenceHigh:optionalNumber(row.referenceHigh),referenceText:row.referenceText,lab:row.lab||''};
 })};
}
async function refresh(){
 if(view.refreshing)return;view.refreshing=true;
 const results=await Promise.allSettled([api.finance(),api.documentReceipts()]);
 if(results[0].status==='fulfilled'){view.finance=results[0].value;if(!view.entityId)view.entityId=entities()[0]?.id||'';}
 if(results[1].status==='fulfilled')view.receipts=results[1].value.receipts||[];
 const failed=results.find(result=>result.status==='rejected');if(failed)view.error=failed.reason.message;view.refreshing=false;paint();
}
function usePreview(preview){
 view.preview=preview;view.receipt=null;view.expandRows=0;invalidate();
 const committed=new Map((preview.committed||[]).map(record=>[record.index,record]));
 view.rows=preview.rows.map(source=>{
  const saved=committed.get(source.index),row={...source,...saved?.values};
  return {...row,selected:false,saved:!!saved,amount:row.amountCents==null?'':(row.amountCents/100).toFixed(2),currency:row.currency||'',category:row.category||'Uncategorized',kind:row.kind==='transfer'?'transfer':'',value:row.value==null?'':String(row.value),lab:row.lab||''};
 });
}
async function fileBase64(file){
 if(file.size>8*1024*1024||file.size<1||!/\.(pdf|png|jpe?g)$/i.test(file.name))throw new Error('Choose a PDF, PNG, or JPEG file up to 8 MB.');
 const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(binary);
}
async function readDocument(){
 if(view.busy||!view.file)return;
 const request=++view.request,controller=new AbortController();view.controller=controller;view.busy='reading';view.error='';view.notice='';paint();
 try{
  const base64=await fileBase64(view.file);controller.signal.throwIfAborted();
  const preview=await api.previewDocument({base64,filename:view.file.name,kind:view.kind},{signal:controller.signal});
  if(request!==view.request)return;usePreview(preview);view.file=null;
 }catch(error){if(request===view.request)view.error=controller.signal.aborted?'Reading stopped. No records were imported.':error.message;}
 finally{if(request===view.request){view.busy='';view.controller=null;paint();focusQuietly(view.root.querySelector('.documents-review-title'));}}
}
async function saveReviewed(){
 if(view.busy)return;let payload;
 try{payload=documentCommitPayload(view);}catch(error){view.error=error.message;view.expandRows++;paint();return;}
 view.busy='saving';view.error='';paint();
 try{
  const receipt=await api.commitDocument(payload);if(receipt?.saved!==true||!receipt.receiptId)throw new Error('No import receipt was returned. Retry the same reviewed rows to check their saved status.');
  view.receipt=receipt;view.notice='';const ids=new Set(receipt.records.map(record=>record.index));
  for(const row of view.rows)if(ids.has(row.index)){row.saved=true;row.selected=false;}invalidate();
  await refresh();
 }catch(error){view.error=error.message;view.expandRows++;}
 finally{view.busy='';paint();}
}
function uploadPanel(){
 const file=el('input',{type:'file',accept:'.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg','aria-label':'Document file',disabled:!!view.busy});
 file.addEventListener('change',()=>{view.file=file.files?.[0]||null;view.preview=null;view.rows=[];view.receipt=null;view.error='';invalidate();paint();});
 return el('section',{class:'documents-panel documents-upload'},[
  el('h2',{text:'Choose a document'}),note('Statements, invoices and lab results. Read privately on your Spark.'),
  el('div',{class:'documents-fields'},[
   field('Document type',select('Document type',view.kind,[['statement','Bank or card statement'],['invoice','Invoice'],['labs','Blood test / lab results']],value=>{view.kind=value;view.preview=null;view.rows=[];view.receipt=null;paint();})),
   el('label',{class:'documents-drop'},[el('span',{class:'documents-upload-mark','aria-hidden':'true',text:'↑'}),el('strong',{text:view.file?view.file.name:'Choose a file'}),el('span',{text:'PDF, PNG or JPEG · up to 8 MB / 12 pages'}),file]),
  ]),
  el('div',{class:'documents-actions'},[button(view.busy==='reading'?'Reading locally…':'Read document',{class:'btn solid',disabled:!!view.busy||!view.file,onClick:readDocument}),
   view.busy==='reading'&&button('Stop reading',{class:'btn quiet',onClick:()=>view.controller?.abort()})]),

 ]);
}
function destinations(){
 if(view.preview.kind==='labs')return note('Selected observations will be added to Health. Copy results and reference ranges as printed; no diagnosis is generated.');
 const accounts=(view.finance?.accounts||[]).filter(account=>account.entityId===view.entityId);
 return el('div',{class:'documents-fields'},[
  field('Workspace',select('Document workspace',view.entityId,[['','Choose workspace'],...entities().map(entity=>[entity.id,entity.name])],value=>{view.entityId=value;view.accountId='';paint();})),
  view.preview.kind==='statement'?field('Account',select('Document account',view.accountId,[['','Choose account'],...accounts.map(account=>[account.id,`${account.name} · ${account.currency}`])],value=>{view.accountId=value;})):
   field('Invoice direction',select('Invoice direction',view.direction,[['','Choose direction'],['payable','I owe this invoice'],['receivable','This invoice is owed to me']],value=>{view.direction=value;})),
  !entities().length&&el('a',{href:'#/finance',text:'Add a workspace and account in Money first.'}),
 ]);
}
function rowEditor(row){
 const kind=view.preview.kind,n=row.index+1,fields=[];
 const summaryTitle=el('strong'),summaryValue=el('span');
 const updateSummary=()=>{summaryTitle.textContent=kind==='labs'?row.name:kind==='invoice'?row.counterparty:row.description;summaryValue.textContent=kind==='labs'?`${row.value} ${row.unit||''}`:`${row.amount} ${row.currency}`;};updateSummary();
 const edit=(label,key,props={})=>field(label,input(`Row ${n} ${label}`,row[key],value=>{row[key]=value;updateSummary();},{disabled:row.saved||!!view.busy,...props}));
 if(kind==='statement')fields.push(edit('Date','date',{type:'date'}),edit('Description','description'),edit('Signed amount','amount',{placeholder:'-24.50 or 120.00'}),edit('Currency','currency',{maxlength:3,placeholder:'USD'}),edit('Category','category'),
  field('Entry type',select(`Row ${n} Entry type`,row.kind,[['','Income or expense from sign'],['transfer','Transfer between accounts']],value=>{row.kind=value;})));
 else if(kind==='invoice')fields.push(edit('Invoice number','number'),edit('Client or supplier','counterparty'),edit('Description','description'),edit('Issue date','issueDate',{type:'date'}),edit('Due date','dueDate',{type:'date'}),edit('Total','amount',{inputmode:'decimal'}),edit('Currency','currency',{maxlength:3,placeholder:'USD'}));
 else fields.push(edit('Date','date',{type:'date'}),edit('Test name','name'),edit('Result as printed','value'),edit('Unit','unit'),edit('Reference minimum','referenceLow',{inputmode:'decimal'}),edit('Reference maximum','referenceHigh',{inputmode:'decimal'}),edit('Reference text','referenceText'),edit('Lab','lab'));
 return el('article',{class:`documents-row${row.saved?' is-saved':''}`},[
  el('div',{class:'documents-row-heading'},[checkbox(row.saved?`Row ${n} already saved`:`Save row ${n}`,row.selected,checked=>{row.selected=checked;invalidate();paint();},row.saved),el('span',{class:'documents-badge',text:row.saved?'Saved':row.evidenceFound?'Source matched':'Check original source'})]),
  el('div',{class:'documents-row-summary'},[summaryTitle,summaryValue]),
  disclosure(`document-row-${view.preview.reviewId}-${row.index}-validation-${view.expandRows}`,'Edit details',[el('fieldset',{class:'documents-fields',disabled:row.saved||!!view.busy},fields)],{open:view.expandRows||!row.evidenceFound}),
  el('details',{class:'documents-evidence'},[el('summary',{text:`Source evidence · ${row.evidencePages?.length?`page${row.evidencePages.length>1?'s':''} ${row.evidencePages.join(', ')}`:'page not verified'}`}),el('blockquote',{text:row.evidence||'No matching excerpt was returned. Check the original document.'})]),
 ]);
}
function reviewPanel(){
 const preview=view.preview,selected=view.rows.filter(row=>row.selected&&!row.saved).length;
 return el('section',{class:'documents-panel documents-review'},[
  el('h2',{class:'documents-review-title',tabindex:-1,text:'Review the suggested records'}),note(`${preview.filename} · ${preview.pages} page${preview.pages===1?'':'s'}${preview.ocr?' · OCR used':''}. Nothing is imported until you save selected rows.`),
  ...preview.warnings.map(warning=>el('p',{class:'documents-warning',text:warning})),destinations(),
  preview.kind==='statement'&&note('Negative amounts are spending; positive amounts are money received or refunded. Mark card payments and account movements as transfers. Each currency remains separate.'),
  preview.kind==='invoice'&&note('Invoices are saved as unpaid. Recording an invoice does not create a bank transaction or make a payment.'),
  el('div',{class:'documents-actions'},[button('Select unsaved rows',{class:'btn quiet',disabled:!!view.busy,onClick:()=>{view.rows.forEach(row=>{if(!row.saved)row.selected=true;});invalidate();paint();}}),button('Clear selection',{class:'btn quiet',disabled:!!view.busy,onClick:()=>{view.rows.forEach(row=>{row.selected=false;});invalidate();paint();}})]),
  ...(view.rows.length?view.rows.map(rowEditor):[note('No rows were found. You can try a clearer file or enter the record in Money or Health.')]),
  el('details',{class:'documents-source'},[el('summary',{text:'Read all extracted source pages'}),...(preview.pageTexts||[]).map(page=>el('section',{},[el('h3',{text:`Page ${page.page}${page.ocr?' · OCR':''}`}),el('pre',{text:page.text||'(No readable text on this page)'})]))]),
  el('div',{class:'documents-save'},[el('h2',{text:'Save your reviewed records'}),note(`${selected} selected. Missing or uncertain values must be corrected before saving.`),
   checkbox('I reviewed the selected rows',view.ack,checked=>{view.ack=checked;}),
   button(view.busy==='saving'?'Saving…':'Save reviewed records',{class:'btn solid',disabled:!!view.busy||selected===0,onClick:saveReviewed})]),
 ]);
}
function receiptPanel(receipt){return el('section',{class:'documents-receipt',role:'status'},[el('h2',{text:receipt.replayed?'Saved import confirmed':'Import saved'}),
 el('p',{text:`${receipt.imported} ${receipt.imported===1?'record':'records'} imported.${receipt.duplicates?` ${receipt.duplicates} already saved ${receipt.duplicates===1?'row':'rows'} skipped.`:''}`}),note(`${receipt.filename} · ${receiptDate(receipt.createdAt)}`),
 el('a',{href:receipt.kind==='labs'?'#/health/labs':'#/finance',text:receipt.kind==='labs'?'Open Health records':'Open Money records'})]);}
function paint(){
 if(!view.root)return;
 view.root.replaceChildren(...[
  el('div',{class:'documents-heading'},[el('div',{},[el('h1',{text:'Imports'}),note('Statements, invoices and lab reports.')]),button('Refresh receipts',{class:'btn quiet',disabled:!!view.busy,onClick:refresh})]),
  el('ol',{class:'documents-steps','aria-label':'Import steps'},['Choose file','Review records','Save'].map((label,index)=>el('li',{class:index===(view.receipt?2:view.preview?1:0)?'is-current':''},[el('span',{text:String(index+1)}),el('strong',{text:label})]))),
  view.error&&el('p',{class:'documents-error',role:'alert',text:view.error}),view.receipt&&receiptPanel(view.receipt),
  view.preview?disclosure('documents-upload','Import another document',[uploadPanel()]):uploadPanel(),view.preview&&reviewPanel(),
  view.receipts.length>0&&disclosure('documents-receipts','Saved import receipts',view.receipts.map(receipt=>el('div',{class:'documents-receipt-row'},[el('strong',{text:receipt.filename}),note(`${receipt.imported} imported · ${receipt.duplicates} skipped · ${receiptDate(receipt.createdAt)}`),note(`Receipt ${receipt.receiptId}`)]))),
 ].filter(Boolean));
}
export function renderDocuments({sub}={}){
 if(['statement','invoice','labs'].includes(sub)&&!view.busy&&!view.file&&!view.preview)view.kind=sub;
 if(!view.root){view.root=el('div',{class:'view view-documents'});refresh();}
 else if(!view.root.isConnected&&!view.busy)refresh();
 paint();return view.root;
}
