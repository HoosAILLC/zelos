/** Private records and user-edited plans. This view does not interpret tests or order groceries. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { todayKey } from '../lib/time.js';
import { disclosure, reveal } from '../lib/workspace.js';

let root, content, tabs, sectionSelect, notice, active='overview', data=null, loading=false, tz, routeSub=null;
const panels=new Map();
const forms=new Set();
const dirtyForms=new Set();
const labels={overview:'Overview',profile:'Goals & preferences',walking:'Walking & measurements',labs:'Lab results',plans:'Meal & exercise plans',groceries:'Groceries'};
const localDate=()=>todayKey(tz);
const field=(label,input)=>el('label',{class:'health-field'},[el('span',{text:label}),input]);
const input=(label,type='text')=>el(type==='textarea'?'textarea':'input',{class:'input',type:type==='textarea'?null:type,'aria-label':label,...(type==='number'?{step:'any'}:{})});
const select=(label,options)=>el('select',{class:'input','aria-label':label},options.map(([value,label])=>el('option',{value,text:label})));
const money=value=>new Intl.NumberFormat(undefined,{style:'currency',currency:/^[A-Z]{3}$/.test(data?.profile?.currency)?data.profile.currency:'USD'}).format(value);
const blank=value=>value==null?'':String(value);
function message(value,bad=false){notice.textContent=value;notice.setAttribute('class',`health-notice${bad?' is-bad':''}`);}
function makeForm(title,fields,save,label='Save') {
  const controls=Object.fromEntries(fields.map(([key,label,type='text',options])=>[key,options?select(label,options):input(label,type)]));
  const status=el('p',{class:'health-form-status',role:'status'});
  const node=el('form',{class:'health-form'},[
    el('h2',{text:title}),el('div',{class:'health-fields'},fields.map(([key,label])=>field(label,controls[key]))),status,
  ]);
  const form={node,controls,status,id:null,updatedAt:null,dirty:false,extraControls:[]};forms.add(form);
  const mark=()=>{form.dirty=true;dirtyForms.add(form);status.textContent='Unsaved changes';};
  for(const control of Object.values(controls)){control.addEventListener('input',mark);control.addEventListener('change',mark);}
  form.values=()=>({...Object.fromEntries(Object.entries(controls).map(([key,control])=>[key,control.value])),expectedUpdatedAt:form.updatedAt||undefined});
  form.fill=value=>{form.id=value?.id||null;form.updatedAt=value?.updatedAt||null;for(const [key,control]of Object.entries(controls))control.value=blank(value?.[key]);form.dirty=false;dirtyForms.delete(form);status.textContent='';};
  form.clear=()=>form.fill({date:localDate()});
  const submit=button(label,{class:'btn solid',onClick:()=>run()});
  node.appendChild(el('div',{class:'health-actions'},[submit,button('Clear form',{class:'btn quiet',onClick:()=>form.clear()})]));
  let saving=false;
  async function run(){
    if(saving)return;saving=true;submit.disabled=true;
    const editingControls=[...node.querySelectorAll('input, select, textarea, button'),...form.extraControls];
    for(const control of editingControls)control.disabled=true;
    status.textContent='Saving…';
    try{const result=await save(form.values(),form);const saved=Object.values(result||{}).find(value=>value&&typeof value==='object'&&value.id);if(saved){form.id=saved.id;form.updatedAt=saved.updatedAt;}form.dirty=false;dirtyForms.delete(form);await load();status.textContent=result?.notice||'Saved on Spark.';}
    catch(error){status.textContent=error.message;}
    finally{saving=false;submit.disabled=false;for(const control of editingControls)control.disabled=false;}
  }
  node.addEventListener('submit',event=>{event.preventDefault();run();});
  form.submit=run;form.mark=mark;
  return form;
}
async function load(){
  if(loading)return;loading=true;
  message('Loading health records…');
  try{data=await api.healthTracking();paint();message('');}
  catch(error){message(error.message,true);}
  finally{loading=false;}
}
function table(headers,rows){
  return el('div',{class:'health-table-wrap'},el('table',{class:'health-table'},[
    el('thead',{},el('tr',{},headers.map(header=>el('th',{scope:'col',text:header})))),
    el('tbody',{},rows.length?rows:el('tr',{},el('td',{colspan:String(headers.length),text:'No records yet.'}))),
  ]));
}
const cells=values=>el('tr',{},values.map(value=>el('td',{},value instanceof Node?value:String(value??'—'))));
function removeButton(kind,record){
  let armed=false;
  return button('Delete',{class:'btn quiet','aria-label':'Delete',onClick:async event=>{
    const trigger=event.currentTarget;
    if(!armed){armed=true;trigger.textContent='Confirm delete';trigger.setAttribute('aria-label','Confirm delete');return;}
    trigger.disabled=true;
    try{await api.deleteHealthRecord({kind,id:record.id});await load();}catch(error){message(error.message,true);trigger.disabled=false;}
  }});
}
function editButton(record,form){return button('Edit',{class:'btn quiet',onClick:()=>{form.fill(record);reveal(form.node);focusQuietly(Object.values(form.controls)[0]);}});}
const actions=(...nodes)=>el('div',{class:'health-row-actions'},nodes);
function section(title,note,children){return el('section',{class:'health-section'},[el('h2',{text:title}),note?el('p',{class:'health-hint',text:note}):null,children]);}
function chart(title,records,value,unit){
  const rows=records.filter(record=>value(record)!==null).slice(0,14).reverse();
  const max=Math.max(1,...rows.map(value));
  return section(title,'Your latest recorded days.',rows.length?el('div',{class:'health-chart',role:'img','aria-label':`${title}: ${rows.map(row=>`${row.date}, ${Math.round(value(row)*100)/100} ${unit}`).join('; ')}`},rows.map(row=>el('div',{class:'health-chart-row'},[
    el('span',{class:'health-chart-date',text:row.date.slice(5)}),
    el('div',{class:'health-chart-track'},el('div',{class:'health-chart-bar',style:{width:`${Math.max(1,value(row)/max*100)}%`}})),
    el('span',{class:'health-chart-value',text:`${Math.round(value(row)*100)/100} ${unit}`}),
  ]))):el('p',{class:'health-hint',text:'Add records to see your history.'}));
}
function overview(){
  const completed=data.plans.flatMap(plan=>plan.entries).filter(entry=>entry.state==='done').length;
  const weights=data.metrics.filter(metric=>metric.kind==='weight');
  const sleep=data.metrics.filter(metric=>metric.kind==='sleep');
  return el('div',{class:'health-stack'},[
    el('div',{class:'health-stats'},[
      ['Walking days',data.walking.length],['Lab results',data.labs.length],['Plan entries completed',completed],['Grocery items needed',data.groceryItems.filter(item=>item.state==='needed').length],
    ].map(([label,value])=>el('div',{class:'health-stat'},[el('strong',{text:String(value)}),el('span',{text:label})]))),
    data.profile.goals?section('Your goals',null,el('p',{class:'health-preserve',text:data.profile.goals})):section('Start with your preferences','Add your goals, food preferences, allergies, exercise limitations and grocery budget before creating a personalized plan.',button('Add goals & preferences',{class:'btn quiet',onClick:()=>activate('profile')})),
    el('div',{class:'health-chart-grid'},[chart('Daily steps',data.walking,row=>row.steps,'steps'),chart('Walking distance',data.walking,row=>row.distanceKm,'km'),chart('Weight',weights,row=>row.baseValue,'kg'),chart('Sleep',sleep,row=>row.baseValue,'hours')]),
  ]);
}
function profilePanel(){
  const form=makeForm('Your goals & preferences',[
    ['goals','Health goals','textarea'],['diet','Diet and food preferences','textarea'],['allergies','Food allergies and foods to avoid','textarea'],
    ['exerciseLimitations','Exercise limitations or clinician instructions','textarea'],['weeklyBudget','Weekly grocery budget','number'],['currency','Currency'],['householdSize','People to plan for','number'],
  ],values=>api.saveHealthProfile(values),'Save preferences');
  form.fill(data.profile);
  return {node:el('div',{class:'health-stack'},[el('p',{class:'health-hint',text:'These preferences guide plans you choose to create. Fill in goals, diet, allergies and exercise limitations; enter “none” where applicable. They stay in your private Health library.'}),form.node]),dirty:()=>form.dirty,paint:()=>{if(!form.dirty)form.fill(data.profile);}};
}
function walkingPanel(){
  const walk=makeForm('Log a day of walking',[
    ['date','Walking date','date'],['steps','Steps','number'],['distance','Distance','number'],['distanceUnit','Distance unit','text',[['km','Kilometres'],['mi','Miles']]],['note','Walking note','textarea'],
  ],(values,form)=>api.saveHealthWalking({...values,id:form.id||undefined}),'Save walking');
  walk.fill({date:localDate(),distanceUnit:'km'});
  const csv=makeForm('Import walking CSV',[
    ['csv','Walking CSV','textarea'],['source','Import source'],['replaceExisting','Existing dates','text',[['','Keep existing records'],['yes','Replace existing records']]],
  ],async(values,form)=>{const result=await api.importHealthWalking({...values,replaceExisting:values.replaceExisting==='yes'});return {notice:`Imported ${result.imported} days; kept ${result.skipped} existing days.`};},'Import CSV');
  const file=el('input',{type:'file',accept:'.csv,text/csv','aria-label':'Choose walking CSV'});
  file.addEventListener('change',async()=>{const chosen=file.files?.[0];if(!chosen)return;if(chosen.size>2000000){csv.status.textContent='Choose a CSV smaller than 2 MB.';return;}csv.controls.csv.value=await chosen.text();csv.mark();});
  csv.node.insertBefore(field('Choose a CSV file',file),csv.node.children[1]);
  csv.node.insertBefore(el('p',{class:'health-hint',text:'Columns: date,steps,distance,distance_unit,note. Use YYYY-MM-DD dates and one daily total per row. Distance units are km or mi; steps or distance may be blank.'}),csv.node.children[1]);
  const metric=makeForm('Log weight or sleep',[
    ['date','Measurement date','date'],['kind','Measurement','text',[['weight','Weight'],['sleep','Sleep']]],['value','Measurement value','number'],['unit','Measurement unit','text',[['kg','Kilograms'],['lb','Pounds'],['hours','Hours']]],['note','Measurement note','textarea'],
  ],(values,form)=>api.saveHealthMetric({...values,id:form.id||undefined}),'Save measurement');
  metric.fill({date:localDate(),kind:'weight',unit:'kg'});
  metric.controls.kind.addEventListener('change',()=>{metric.controls.unit.value=metric.controls.kind.value==='sleep'?'hours':'kg';});
  const records=el('div');
  const paint=()=>records.replaceChildren(section('Walking records',null,table(['Date','Steps','Distance','Note',''],data.walking.map(row=>cells([row.date,row.steps, row.distance===null?'—':`${row.distance} ${row.distanceUnit}`,row.note,actions(editButton(row,walk),removeButton('walking',row))])))),
    section('Weight & sleep records',null,table(['Date','Measurement','Value','Note',''],data.metrics.map(row=>cells([row.date,row.kind,`${row.value} ${row.unit}`,row.note,actions(editButton(row,metric),removeButton('metric',row))])))));
  paint();return {node:el('div',{class:'health-stack'},[disclosure('health-walk','Log walking',[walk.node]),disclosure('health-measure','Log weight or sleep',[metric.node]),records,disclosure('health-walking-import','Import walking CSV',[csv.node])]),paint};
}
function labPanel(){
  const form=makeForm('Add a lab result',[
    ['date','Lab date','date'],['name','Test name'],['value','Result value'],['unit','Lab result unit'],['referenceLow','Lab reference minimum','number'],['referenceHigh','Lab reference maximum','number'],['referenceText','Reference range as printed'],['lab','Laboratory'],['documentNote','Document note','textarea'],
  ],(values,form)=>api.saveHealthLab({...values,id:form.id||undefined}),'Save lab result');
  form.fill({date:localDate()});
  const records=el('div');
  const paint=()=>records.replaceChildren(table(['Date','Test / lab','Result','Lab reference','Document note',''],data.labs.map(row=>cells([
    row.date,`${row.name}${row.lab?' · '+row.lab:''}`,`${row.value}${row.unit?' '+row.unit:''}`,
    row.referenceText||[row.referenceLow??'',row.referenceHigh??''].join(' – '),row.documentNote,actions(editButton(row,form),removeButton('lab',row)),
  ]))));
  paint();return {node:el('div',{class:'health-stack'},[el('div',{class:'workspace-section-head'},[el('div',{},[el('h2',{text:'Lab results'}),el('p',{class:'health-hint',text:'Your results and reference ranges, as reported. Zelos does not interpret results.'})]),el('a',{class:'btn solid health-inline-action',href:'#/documents/labs',text:'Import a lab report'})]),disclosure('health-lab-form','Add a result manually',[form.node]),records]),paint};
}
const recipeUnits=['g','kg','ml','l','tsp','tbsp','cup','item'];
const sourceURLs=new Set(['https://www.who.int/news-room/fact-sheets/detail/healthy-diet','https://www.cdc.gov/physical-activity-basics/adding-adults/index.html','https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies']);
function plannerPanel(){
  let preview=null,controller=null,modelWaiting=false,saving=false,saved=false,groceryManual=false,groceryReview=false,modelName='your local model';
  const previewSummary=el('p',{class:'health-hint'});
  const draftGuard={};
  const week=input('Draft week starting','date');week.value=localDate();
  const instructions=input('Planning instructions','textarea');instructions.setAttribute('maxlength','2000');instructions.setAttribute('placeholder','For example: quick lunches, simple dinners, and activities I can do at home.');
  const status=el('p',{class:'health-form-status',role:'status','aria-live':'polite'});
  const profileHint=el('p',{class:'health-hint'});
  const staleHint=el('p',{class:'health-preview-alert',role:'status',hidden:true});
  const area=el('div',{class:'health-generated-preview',hidden:true});
  const groceryArea=el('div',{class:'health-preview-groceries'});
  const groceryHint=el('div',{class:'health-preview-alert',hidden:true},[
    el('p',{text:'Meal ingredients changed after you edited the grocery list. Rebuild it from the meals or keep your reviewed grocery edits.'}),
    actions(button('Rebuild groceries from meals',{class:'btn quiet',onClick:()=>{if(saving||saved)return;groceryManual=false;groceryReview=false;rebuildGroceries();paint();}}),
      button('Keep my grocery edits',{class:'btn quiet',onClick:()=>{if(saving||saved)return;groceryReview=false;paint();}})),
  ]);
  const generate=button('Draft a week with Nemotron',{class:'btn solid',onClick:()=>run()});
  const cancel=button('Stop drafting',{class:'btn quiet',hidden:true,onClick:()=>{
    if(!controller||!modelWaiting)return;controller.abort();controller=null;modelWaiting=false;status.textContent=preview?'Drafting stopped. Your previous draft is still here.':'Drafting stopped. Nothing was saved.';paint();
  }});
  const save=button('Save reviewed plan',{class:'btn solid',onClick:()=>commit()});
  const discard=button('Discard draft',{class:'btn quiet',onClick:()=>{if(controller||saving)return;preview=null;saved=false;area.hidden=true;area.replaceChildren();status.textContent='Draft cleared.';paint();}});
  const node=el('section',{class:'health-form health-planner'},[
    el('div',{class:'health-planner-heading'},[el('h2',{text:'Plan a week with Nemotron'}),el('span',{class:'health-local-label',text:'Runs on Spark'})]),
    el('p',{class:'health-hint',text:'A week of meals, movement and groceries, ready for your review.'}),
    profileHint,button('Edit goals & preferences',{class:'btn quiet health-inline-action',onClick:()=>activate('profile')}),
    el('div',{class:'health-fields'},[field('Week starting',week),field('Optional planning instructions',instructions)]),
    actions(generate,cancel),status,staleHint,area,
  ]);
  const incomplete=()=>['goals','diet','allergies','exerciseLimitations'].filter(key=>!data?.profile?.[key]?.trim());
  const stale=()=>Boolean(preview&&preview.profileUpdatedAt!==data?.profile?.updatedAt);
  function paint(){
    const busy=Boolean(controller)||saving;
    const unsavedPreferences=panels.get('profile')?.dirty?.();
    const missing=incomplete();
    profileHint.textContent=unsavedPreferences?'Save your changed preferences before drafting a week.':missing.length?'Complete goals, diet, allergies and exercise limitations first. Enter “none” where applicable.':'Uses your saved goals and preferences.';
    generate.disabled=busy||Boolean(unsavedPreferences)||Boolean(missing.length);week.disabled=busy;instructions.disabled=busy;
    cancel.hidden=!controller||!modelWaiting;cancel.disabled=!controller||!modelWaiting;
    staleHint.hidden=!stale()||saved;staleHint.textContent='Your saved preferences changed. Draft a new week before saving this plan.';
    groceryHint.hidden=!groceryReview;
    previewSummary.textContent=saved?'Saved in your Health library. Edit the saved plan below to make further changes.':`Drafted with ${modelName}. Nothing has been saved or ordered.`;
    for(const control of area.querySelectorAll('input, select, textarea, button'))control.disabled=busy||saved;
    save.disabled=busy||saved||stale()||groceryReview||Boolean(unsavedPreferences);discard.disabled=busy;
    if(controller||saving||preview&&!saved)dirtyForms.add(draftGuard);else dirtyForms.delete(draftGuard);
  }
  function changed(){saved=false;paint();}
  function bind(control,object,key,{numeric=false,ingredients=false,groceries=false}={}){
    control.value=blank(object[key]);
    control.addEventListener(control.tagName==='SELECT'?'change':'input',()=>{
      if(saving||saved||controller)return;
      object[key]=numeric?(control.value.trim()===''?null:Number(control.value)):control.value;
      if(groceries)groceryManual=true;
      if(ingredients){if(groceryManual)groceryReview=true;else rebuildGroceries();}
      changed();
    });
    return control;
  }
  function rebuildGroceries(){
    if(!preview)return;const grouped=new Map();
    preview.entries.forEach((entry,index)=>{for(const ingredient of entry.ingredients||[]){
      const unit=ingredient.unit==='kg'?'g':ingredient.unit==='l'?'ml':ingredient.unit;
      const quantity=Number(ingredient.quantity)*(['kg','l'].includes(ingredient.unit)?1000:1);
      const key=`${String(ingredient.name).trim().toLowerCase().replace(/\s+/g,' ')}\0${unit}`;
      const item=grouped.get(key)||{name:ingredient.name,quantity:0,unit,mealRefs:[]};
      item.quantity=Math.round((item.quantity+quantity)*100)/100;if(!item.mealRefs.includes(index))item.mealRefs.push(index);grouped.set(key,item);
    }});
    preview.groceries=[...grouped.values()];paintGroceries();
  }
  function paintGroceries(){
    groceryArea.replaceChildren(...preview.groceries.map((item,index)=>{
      const name=bind(input(`Grocery ${index+1} name`),item,'name',{groceries:true});
      const quantity=bind(input(`Grocery ${index+1} quantity`,'number'),item,'quantity',{numeric:true,groceries:true});quantity.setAttribute('min','0.01');quantity.setAttribute('step','0.01');
      const unit=bind(select(`Grocery ${index+1} unit`,recipeUnits.map(unit=>[unit,unit])),item,'unit',{groceries:true});
      return el('div',{class:'health-ingredient-row'},[field('Item',name),field('Quantity',quantity),field('Unit',unit),button('Remove grocery',{class:'btn quiet','aria-label':`Remove grocery ${index+1}`,onClick:()=>{
        if(saving||saved||controller)return;preview.groceries.splice(index,1);groceryManual=true;paintGroceries();changed();
      }})]);
    }));
  }
  function ingredientEditor(entry,entryIndex){
    const holder=el('div',{class:'health-preview-ingredients'});
    function render(){holder.replaceChildren(...entry.ingredients.map((ingredient,index)=>{
      const prefix=`Meal ${entryIndex+1} ingredient ${index+1}`;
      const quantity=bind(input(`${prefix} quantity`,'number'),ingredient,'quantity',{numeric:true,ingredients:true});quantity.setAttribute('min','0.01');quantity.setAttribute('step','0.01');
      return el('div',{class:'health-ingredient-row'},[
        field('Ingredient',bind(input(`${prefix} name`),ingredient,'name',{ingredients:true})),field('Quantity',quantity),
        field('Unit',bind(select(`${prefix} unit`,recipeUnits.map(unit=>[unit,unit])),ingredient,'unit',{ingredients:true})),
        button('Remove ingredient',{class:'btn quiet','aria-label':`Remove ${prefix.toLowerCase()}`,onClick:()=>{if(saving||saved||controller)return;entry.ingredients.splice(index,1);render();if(groceryManual)groceryReview=true;else rebuildGroceries();changed();}}),
      ]);
    }));}
    render();return el('div',{class:'health-stack health-recipe-ingredients'},[holder,button('Add ingredient',{class:'btn quiet','aria-label':`Add ingredient to meal ${entryIndex+1}`,onClick:()=>{
      if(saving||saved||controller)return;entry.ingredients.push({name:'',quantity:1,unit:'item'});render();if(groceryManual)groceryReview=true;else rebuildGroceries();changed();
    }})]);
  }
  function entryEditor(entry,index){
    const meal=entry.kind==='meal';const prefix=`${meal?'Meal':'Activity'} ${index+1}`;
    const controls=[field(meal?'Meal':'Activity',bind(input(`${prefix} title`),entry,'title')),field(meal?'Preparation':'Activity details',bind(input(`${prefix} details`,'textarea'),entry,'details'))];
    if(!meal){
      const duration=bind(input(`${prefix} duration`,'number'),entry,'durationMinutes',{numeric:true});duration.setAttribute('min','0');duration.setAttribute('max','45');duration.setAttribute('step','1');
      controls.push(field('Minutes',duration),field('Effort',bind(select(`${prefix} intensity`,(entry.activity==='rest'?['rest']:['light','moderate']).map(value=>[value,value])),entry,'intensity')));
    }
    return el('section',{class:'health-preview-entry'},[
      el('h4',{text:meal?entry.mealSlot[0].toUpperCase()+entry.mealSlot.slice(1):`Activity · ${entry.activity.replaceAll('_',' ')}`}),
      el('div',{class:'health-fields'},controls),meal?ingredientEditor(entry,index):null,
    ]);
  }
  function renderPreview(model){
    modelName=model;
    const title=bind(input('Reviewed plan title'),preview,'title');title.setAttribute('maxlength','150');
    const days=[...new Set(preview.entries.map(entry=>entry.date))];
    const sourceList=el('ul',{class:'health-preview-sources'},(preview.sources||[]).map(source=>el('li',{},sourceURLs.has(source.url)
      ?el('a',{href:source.url,target:'_blank',rel:'noopener noreferrer',text:source.title}):el('span',{text:source.title||'Source unavailable'}))));
    const addGrocery=button('Add grocery item to draft',{class:'btn quiet',onClick:()=>{if(saving||saved||controller)return;preview.groceries.push({name:'',quantity:1,unit:'item',mealRefs:[]});groceryManual=true;paintGroceries();changed();}});
    paintGroceries();
    area.replaceChildren(
      el('div',{class:'health-preview-heading'},[el('h3',{text:'Review your week'}),previewSummary]),
      field('Plan title',title),
      el('details',{class:'health-preview-assumptions'},[el('summary',{text:'Assumptions & guidance'}),el('ul',{},(preview.assumptions||[]).map(value=>el('li',{text:value}))),sourceList]),
      el('div',{class:'health-preview-days'},days.map((date,dayIndex)=>el('details',{class:'health-preview-day',open:dayIndex===0},[
        el('summary',{},[el('span',{text:date}),el('span',{text:preview.entries.filter(entry=>entry.date===date).map(entry=>entry.kind==='meal'?entry.mealSlot:'activity').join(' · ')})]),
        ...preview.entries.map((entry,index)=>entry.date===date?entryEditor(entry,index):null),
      ]))),
      el('section',{class:'health-preview-shopping'},[el('h3',{text:'Review grocery quantities'}),el('p',{class:'health-hint',text:'Amounts cover the whole household. Remove ingredients you already have and adjust what you want to buy. Actual prices and availability have not been checked.'}),groceryHint,groceryArea,addGrocery]),
      el('p',{class:'health-hint',text:'Saving adds this reviewed plan and its grocery list to Health. It does not place an order.'}),actions(save,discard),
    );
    area.hidden=false;paint();
  }
  async function run(){
    if(controller||saving||generate.disabled)return;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(week.value)){status.textContent='Choose the first day of the week.';return;}
    const owned=new AbortController();controller=owned;modelWaiting=true;status.textContent='Nemotron is drafting your week on Spark…';paint();
    try{
      const result=await api.generateHealthPlan({weekStart:week.value,instructions:instructions.value},{signal:owned.signal});
      if(controller!==owned||owned.signal.aborted)return;
      const candidate=result?.preview;
      if(!candidate?.id||!Array.isArray(candidate.entries)||!Array.isArray(candidate.groceries))throw new Error('The plan could not be displayed. Try drafting again.');
      modelWaiting=false;preview=JSON.parse(JSON.stringify(candidate));saved=false;groceryManual=false;groceryReview=false;renderPreview(result.model||'your local model');
      await load();if(controller!==owned||owned.signal.aborted)return;
      status.textContent='Your draft is ready. Review the meals, activity and grocery quantities before saving.';
      area.scrollIntoView({block:'start'});focusQuietly(area.querySelector('[aria-label="Reviewed plan title"]'));
    }catch(error){if(controller===owned&&!owned.signal.aborted)status.textContent=error.message||'Planning failed. Your existing draft is unchanged.';}
    finally{if(controller===owned){controller=null;modelWaiting=false;paint();}}
  }
  function validateEdits(){
    if(!preview.title.trim())throw new Error('Add a plan title before saving.');
    for(const entry of preview.entries){
      if(!entry.title.trim()||!entry.details.trim())throw new Error('Review each meal and activity title and its instructions.');
      if(entry.kind==='meal'){
        if(!entry.ingredients?.length)throw new Error('Each meal needs ingredients with quantities.');
        for(const ingredient of entry.ingredients)if(!ingredient.name.trim()||!Number.isFinite(ingredient.quantity)||ingredient.quantity<=0||!recipeUnits.includes(ingredient.unit))throw new Error('Review every ingredient name, quantity and unit.');
      }else if(!Number.isInteger(entry.durationMinutes)||entry.durationMinutes<(entry.activity==='rest'?0:5)||entry.durationMinutes>(entry.activity==='rest'?0:45))throw new Error('Activity sessions need 5–45 minutes; rest entries need zero minutes.');
    }
    for(const item of preview.groceries)if(!item.name.trim()||!Number.isFinite(item.quantity)||item.quantity<=0||!recipeUnits.includes(item.unit))throw new Error('Review every grocery name, quantity and unit.');
  }
  async function commit(){
    if(!preview||saving||controller||save.disabled)return;
    try{validateEdits();}catch(error){status.textContent=error.message;return;}
    saving=true;status.textContent='Saving your reviewed plan on Spark…';paint();
    try{
      const result=await api.saveHealthPlanPreview({preview:JSON.parse(JSON.stringify(preview)),reviewed:true});
      if(result?.saved!==true)throw new Error('The save was not confirmed. Keep this draft and retry.');
      saved=true;status.textContent=`Saved your plan and ${result.groceryCount} grocery items on Spark. No order was placed.`;
      await load();
    }catch(error){status.textContent=error.message||'The save was not confirmed. Keep this draft and retry.';}
    finally{saving=false;paint();}
  }
  paint();return {node,paint};
}

function plansPanel(){
  const planner=plannerPanel();
  let editingId=null;const entries=[];const entryArea=el('div',{class:'health-plan-editor'});
  const plan=makeForm('Create or edit a plan', [['title','Plan title'],['weekStart','Week starting','date'],['note','Plan note','textarea']],async values=>{
    const result=await api.saveHealthPlan({...values,id:editingId||undefined,entries:entries.map(entry=>({...entry.metadata,id:entry.id||undefined,...Object.fromEntries(Object.entries(entry.controls).map(([key,node])=>[key,node.value])),state:entry.state||'planned'}))});
    editingId=result.plan.id;entries.forEach((entry,index)=>{entry.id=result.plan.entries[index].id;});return result;
  },'Save plan');
  plan.fill({weekStart:localDate()});
  function addEntry(value={}){
    const controls={date:input('Entry date','date'),kind:select('Entry type',[['meal','Meal'],['workout','Workout']]),title:input('Meal or workout title'),details:input('Entry details','textarea')};
    for(const [key,control]of Object.entries(controls)){control.value=blank(value[key]??(key==='date'?plan.controls.weekStart.value:key==='kind'?'meal':''));control.addEventListener('input',plan.mark);control.addEventListener('change',plan.mark);}
    const metadata=Object.fromEntries(['ingredients','mealSlot','durationMinutes','intensity','activity'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
    const entry={id:value.id,state:value.state||'planned',controls,metadata};plan.extraControls.push(...Object.values(controls));
    const title=el('span');const updateTitle=()=>{title.textContent=`${controls.date.value || 'Choose a date'} · ${controls.title.value || 'New meal or workout'}`;};updateTitle();
    controls.title.addEventListener('input',updateTitle);controls.date.addEventListener('input',updateTitle);
    entry.node=el('details',{class:'workspace-disclosure health-plan-entry-form',open:!value.id},[
      el('summary',{},[title,el('span',{class:'workspace-chevron','aria-hidden':'true',text:'+'})]),
      el('div',{class:'workspace-disclosure-body'},[
      el('div',{class:'health-fields'},Object.entries(controls).map(([key,node])=>field({date:'Date',kind:'Type',title:'Meal or workout',details:'Details'}[key],node))),
      button('Remove entry',{class:'btn quiet',onClick:()=>{entries.splice(entries.indexOf(entry),1);entry.node.remove();plan.mark();}}),
      ]),
    ]);entries.push(entry);entryArea.appendChild(entry.node);return entry;
  }
  const add=button('Add meal or workout',{class:'btn quiet',onClick:()=>{const entry=addEntry();plan.mark();reveal(entry.controls.title);focusQuietly(entry.controls.title);}});
  plan.node.insertBefore(entryArea,plan.status);plan.node.insertBefore(add,plan.status);
  plan.extraControls.push(add);
  plan.clear=()=>{editingId=null;entries.length=0;entryArea.replaceChildren();plan.fill({weekStart:localDate()});};
  const startNew=button('Start a new plan',{class:'btn quiet',onClick:()=>{plan.clear();reveal(plan.node);}});plan.extraControls.push(startNew);
  const records=el('div',{class:'health-stack'});
  const planCount=el('p',{class:'health-hint'});
  const paint=()=>{planCount.textContent=`${data.plans.length} saved ${data.plans.length===1?'plan':'plans'}`;records.replaceChildren(...data.plans.map(record=>disclosure(`health-saved-plan-${record.id}`,record.title,[el('div',{class:'health-stack'},[
    el('p',{class:'health-hint',text:`Week starting ${record.weekStart} · ${record.entries.filter(entry=>entry.state==='done').length} of ${record.entries.length} completed`}),record.note?disclosure(`health-plan-note-${record.id}`,'Plan notes',[el('p',{class:'health-preserve',text:record.note})]):null,
    ...[...new Set(record.entries.map(entry=>entry.date))].map(day=>disclosure(`health-plan-day-${record.id}-${day}`,new Intl.DateTimeFormat(undefined,{timeZone:'UTC',weekday:'long',month:'short',day:'numeric'}).format(new Date(`${day}T12:00:00Z`)),record.entries.filter(entry=>entry.date===day).map(entry=>el('div',{class:'health-plan-entry'},[
      el('div',{},[el('strong',{text:entry.title}),el('p',{class:'health-hint',text:`${entry.date} · ${entry.mealSlot||entry.kind} · ${entry.state}${entry.durationMinutes!==undefined?` · ${entry.durationMinutes} minutes · ${entry.intensity||''}`:''}`}),el('p',{class:'health-preserve',text:entry.details}),entry.ingredients?.length?el('ul',{class:'health-saved-ingredients'},entry.ingredients.map(ingredient=>el('li',{text:`${ingredient.name} · ${ingredient.quantity} ${ingredient.unit}`}))):null]),
      actions(...[['done','Mark completed'],['planned','Mark planned'],['skipped','Skip']].filter(([value])=>value!==entry.state).map(([state,label])=>button(label,{class:'btn quiet',onClick:async event=>{const trigger=event.currentTarget;trigger.disabled=true;try{await api.setHealthPlanEntryState({id:entry.id,state});await load();}catch(error){message(error.message,true);trigger.disabled=false;}}}))),
    ])))),
    actions(button('Edit plan',{class:'btn quiet',onClick:()=>{editingId=record.id;plan.fill(record);entries.length=0;entryArea.replaceChildren();record.entries.forEach(addEntry);reveal(plan.node);focusQuietly(plan.controls.title);}}),removeButton('plan',record)),
  ])])));};
  paint();return {node:el('div',{class:'health-stack'},[planner.node,disclosure('health-plan-editor','Create a plan manually',[startNew,plan.node]),el('div',{class:'workspace-section-head'},[el('h2',{text:'Saved plans'}),planCount]),records]),paint:()=>{paint();planner.paint();}};
}
function groceriesPanel(){
  const form=makeForm('Add a grocery item',[
    ['name','Grocery item'],['quantity','Quantity'],['estimatedCost','Estimated cost','number'],['planId','Related plan','text',[['','No plan']]],['entryId','Related meal','text',[['','No meal']]],['state','Grocery status','text',[['needed','Needed'],['have','Already have'],['bought','Bought']]],
  ],(values,form)=>api.saveHealthGrocery({...values,id:form.id||undefined}),'Save grocery item');
  form.fill({state:'needed'});
  const syncMeals=()=>{const selected=form.controls.entryId.value;const plan=data.plans.find(plan=>plan.id===form.controls.planId.value);form.controls.entryId.replaceChildren(el('option',{value:'',text:'No specific meal'}),...(plan?.entries||[]).filter(entry=>entry.kind==='meal').map(entry=>el('option',{value:entry.id,text:`${entry.date} · ${entry.title}`})));form.controls.entryId.value=selected;};
  form.controls.planId.addEventListener('change',syncMeals);
  const records=el('div');const review=el('div',{hidden:true,class:'health-shopping-review'});
  const paint=()=>{
    const selected=form.controls.planId.value;
    form.controls.planId.replaceChildren(el('option',{value:'',text:'No plan'}),...data.plans.map(plan=>el('option',{value:plan.id,text:plan.title})));form.controls.planId.value=selected;syncMeals();
    records.replaceChildren(table(['Item','Quantity','Estimate','Related plan / meal','Status',''],data.groceryItems.map(row=>{
      const plan=data.plans.find(plan=>plan.id===row.planId);const meal=plan?.entries.find(entry=>entry.id===row.entryId);
      return cells([row.name,row.quantity,row.estimatedCost===null?'—':money(row.estimatedCost),[plan?.title,meal?.title].filter(Boolean).join(' · '),row.state,
        actions(button('Edit',{class:'btn quiet',onClick:()=>{form.fill(row);syncMeals();form.controls.entryId.value=row.entryId||'';reveal(form.node);focusQuietly(form.controls.name);}}),removeButton('grocery',row))]);
    })));
  };
  const reviewButton=button('Review shopping list',{class:'btn solid',onClick:()=>{
    const needed=data.groceryItems.filter(item=>item.state==='needed');const total=needed.reduce((sum,item)=>sum+(item.estimatedCost||0),0);const unknown=needed.filter(item=>item.estimatedCost===null).length;
    review.hidden=false;review.replaceChildren(el('h2',{text:'Shopping review'}),el('ul',{},needed.map(item=>el('li',{text:`${item.name}${item.quantity?' · '+item.quantity:''}${item.estimatedCost!==null?' · '+money(item.estimatedCost):' · price not entered'}`}))),
      el('p',{text:`Entered estimates: ${money(total)}${unknown?` · ${unknown} items have no price`:''}.`}),
      el('p',{text:data.profile.weeklyBudget===null?'Add a weekly grocery budget in Goals & preferences.':`Weekly budget: ${money(data.profile.weeklyBudget)}.${total>data.profile.weeklyBudget?' The entered estimates exceed your budget.':''}`}),
      el('p',{class:'health-hint',text:'No order has been placed. A retailer, account, final prices, delivery details and your approval are needed before shopping can proceed.'}),
      button('Back to grocery list',{class:'btn quiet',onClick:()=>{review.hidden=true;}}));review.scrollIntoView({block:'center'});
  }});
  paint();return {node:el('div',{class:'health-stack'},[el('div',{class:'workspace-section-head'},[el('h2',{text:'Grocery records'}),el('a',{class:'btn solid health-inline-action',href:'#/shopping',text:'Open shopping workspace'})]),disclosure('health-grocery-form','Add a grocery item',[form.node]),records,disclosure('health-grocery-estimates','Review estimates',[reviewButton,review])]),paint};
}
function activate(key){active=key;paint();}
function paint(){
  if(!data)return;
  sectionSelect.value=active;
  tabs.replaceChildren(...Object.entries(labels).map(([key,label])=>button(label,{class:`btn quiet${key===active?' is-current':''}`,'aria-pressed':key===active?'true':'false',onClick:()=>activate(key)})));
  if(active==='overview'){content.replaceChildren(overview());return;}
  if(!panels.has(active))panels.set(active,({profile:profilePanel,walking:walkingPanel,labs:labPanel,plans:plansPanel,groceries:groceriesPanel})[active]());
  const panel=panels.get(active);panel.paint?.();content.replaceChildren(panel.node);
}
window.addEventListener('beforeunload',event=>{if(!dirtyForms.size)return;event.preventDefault();event.returnValue='';});
export function renderHealth(ctx={}){
  tz=ctx.tz;
  const entering=!!root&&!root.isConnected;
  const changedSection=Object.hasOwn(labels,ctx.sub||'')&&(entering||ctx.sub!==routeSub);
  if(changedSection)active=ctx.sub;
  routeSub=ctx.sub||null;
  if(!root){
    notice=el('p',{class:'health-notice',role:'status'});tabs=el('div',{class:'health-tabs','aria-label':'Health sections'});content=el('div',{class:'health-content'});
    sectionSelect=select('Health section',Object.entries(labels));sectionSelect.addEventListener('change',()=>activate(sectionSelect.value));
    root=el('div',{class:'view view-health'},[
      el('div',{class:'health-heading'},[el('div',{},[el('h1',{text:'Health'}),el('p',{text:'Activity, results and weekly plans.'})]),button('Refresh records',{class:'btn quiet',onClick:()=>load()})]),notice,tabs,el('label',{class:'health-mobile-nav'},[el('span',{text:'Section'}),sectionSelect]),content,
    ]);load();
  }else if(entering&&!loading)load();
  else if(changedSection)paint();
  return root;
}
