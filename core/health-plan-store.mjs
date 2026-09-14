/** Explicitly reviewed, atomic, repeat-safe persistence of a generated plan. */
import crypto from 'node:crypto';
import {getKV,setKV,withTransaction} from './db.mjs';
import {getHealth,savePlan,saveGroceryItem,HealthError} from './health.mjs';
export function saveHealthPlanPreview(db,input){
 const preview=input?.preview;
 if(input?.reviewed!==true||!preview||typeof preview.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(preview.id))throw new HealthError(400,'Review the plan before saving it.');
 if(!Array.isArray(preview.entries)||preview.entries.length>200||!Array.isArray(preview.groceries)||preview.groceries.length>250)throw new HealthError(400,'The reviewed plan has too many entries.');
 const digest=crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex'),key='health.plan.receipt.'+preview.id;
 let existing;try{existing=JSON.parse(getKV(db,key));}catch{}
 if(existing){if(existing.digest!==digest)throw new HealthError(409,'This plan was already saved. Edit its saved version in Health.');return existing.receipt;}
 const profile=getHealth(db).profile;
 if(preview.profileUpdatedAt!==profile.updatedAt)throw new HealthError(409,'Your health preferences changed. Generate a new plan before saving.');
 return withTransaction(db,()=>{
  const note=[...(Array.isArray(preview.assumptions)?preview.assumptions.filter(x=>typeof x==='string'):[]),...(Array.isArray(preview.sources)?preview.sources.map(source=>[source.title,source.url].filter(x=>typeof x==='string').join(': ')):[])].join('\n').slice(0,4000);
  const {plan}=savePlan(db,{id:'generated_'+preview.id,title:preview.title,weekStart:preview.weekStart,note,entries:preview.entries.map((entry,index)=>({id:`${preview.id}_${index}`,date:entry.date,kind:entry.kind,title:entry.title,details:entry.details,state:'planned',...Object.fromEntries(['ingredients','mealSlot','durationMinutes','intensity','activity'].filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]]))}))});
  for(const [index,item] of preview.groceries.entries()){
   if(typeof item.name!=='string'||typeof item.unit!=='string'||!Number.isFinite(item.quantity)||item.quantity<=0||item.quantity>100000)throw new HealthError(400,'Review each grocery quantity before saving.');
   const entry=Array.isArray(item.mealRefs)?plan.entries[item.mealRefs.find(i=>Number.isInteger(i)&&plan.entries[i]?.kind==='meal')]:null;
   saveGroceryItem(db,{id:`${preview.id}_grocery_${index}`,planId:plan.id,entryId:entry?.id,name:item.name,quantity:`${item.quantity} ${item.unit}`,state:'needed'});
  }
  const receipt={plan,groceryCount:preview.groceries.length,saved:true,ordered:false};setKV(db,key,JSON.stringify({digest,receipt}));return receipt;
 });
}
