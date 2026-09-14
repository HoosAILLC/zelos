import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateHealth,getHealth,saveProfile,saveWalking,importWalking,saveLab,saveMetric,savePlan,setPlanEntryState,saveGroceryItem,deleteHealthRecord,healthDate } from '../core/health.mjs';
function fixture(t){const db=new DatabaseSync(':memory:');migrateHealth(db);t.after(()=>db.close());return db;}

test('migration is idempotent and records persist across reopening',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-health-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'records.sqlite');let db=new DatabaseSync(file);migrateHealth(db);
 saveProfile(db,{goals:'Walk with a friend',allergies:'Peanuts',weeklyBudget:80});saveWalking(db,{date:'2026-09-11',steps:5000,distance:2.5,distanceUnit:'mi'});
 migrateHealth(db);db.close();db=new DatabaseSync(file);migrateHealth(db);
 assert.equal(getHealth(db).walking.length,1);assert.equal(getHealth(db).profile.allergies,'Peanuts');db.close();
});
test('profile patches preserve sensitive preferences and ignore unrelated config or credentials',t=>{
 const db=fixture(t);saveProfile(db,{goals:'Build a routine',allergies:'Peanuts',diet:'Vegetarian',exerciseLimitations:'Follow my clinician’s written limits',weeklyBudget:'95.50'});
 saveProfile(db,{goals:'Improve consistency',apiKey:'secret-not-health-data',mail:[{password:'never-store'}]});
 const profile=getHealth(db).profile;assert.equal(profile.allergies,'Peanuts');assert.equal(profile.diet,'Vegetarian');assert.equal(profile.weeklyBudget,95.5);assert.equal(profile.goals,'Improve consistency');
 assert.doesNotMatch(JSON.stringify(profile),/secret-not-health-data|password|apiKey|mail/);
 assert.throws(()=>saveProfile(db,{weeklyBudget:-1}),/between/);assert.throws(()=>saveProfile(db,{householdSize:1.5}),/whole/);
 assert.equal(getHealth(db).profile.weeklyBudget,95.5);
});
test('dates validate real leap days, steps are whole numbers, and units are explicit',t=>{
 const db=fixture(t);assert.equal(healthDate('2024-02-29'),'2024-02-29');
 for(const date of ['2025-02-29','2026-02-30','09/11/2026','2026-13-01','2026-09-11T00:00Z'])assert.throws(()=>healthDate(date));
 assert.throws(()=>saveWalking(db,{date:'2026-09-11',steps:1.4}),/whole/);assert.throws(()=>saveWalking(db,{date:'2026-09-11',steps:-4}),/between/);
 assert.throws(()=>saveWalking(db,{date:'2026-09-11',steps:100,distance:3,distanceUnit:'yards'}),/unit/);
 const walk=saveWalking(db,{date:'2026-09-11',steps:0,distance:1,distanceUnit:'mi'}).walking;
 assert.equal(walk.distanceKm,1.609344);assert.equal(walk.steps,0);assert.equal(walk.distance,1);
 saveWalking(db,{id:walk.id,date:walk.date,steps:250,distance:2,distanceUnit:'km'});assert.equal(getHealth(db).walking.length,1);
});
test('CSV import supports quoted notes and repeat imports never duplicate or silently replace daily records',t=>{
 const db=fixture(t);const csv='date,steps,distance,distance_unit,note\r\n2026-09-10,3456,1.25,mi,"Walk, with a friend"\r\n2026-09-11,4000,,km,"A ""quoted"" note"';
 assert.deepEqual(importWalking(db,{csv,source:'Watch export'}),{imported:2,skipped:0});
 assert.deepEqual(importWalking(db,{csv}),{imported:0,skipped:2});
 const records=getHealth(db).walking;assert.equal(records.length,2);assert.equal(records[1].note,'Walk, with a friend');assert.equal(records[0].note,'A "quoted" note');
 saveWalking(db,{date:'2026-09-10',steps:999,distance:1,distanceUnit:'km'});
 importWalking(db,{csv});assert.equal(getHealth(db).walking.find(row=>row.date==='2026-09-10').steps,999);
 importWalking(db,{csv,replaceExisting:true});assert.equal(getHealth(db).walking.find(row=>row.date==='2026-09-10').steps,3456);
});
test('a malformed CSV is rejected before any record is written',t=>{
 const db=fixture(t);saveWalking(db,{date:'2026-09-01',steps:500});
 for(const csv of ['date,steps\n2026-09-10,100\n2026-02-30,200','date,steps\n2026-09-10,100\n2026-09-10,200','date,steps\n2026-09-10,"100','date,steps\n2026-09-10,Infinity'])assert.throws(()=>importWalking(db,{csv}));
 assert.deepEqual(getHealth(db).walking.map(row=>row.date),['2026-09-01']);
});
test('lab values, units, reference text and document notes remain literal and have no interpretation',t=>{
 const db=fixture(t);const lab=saveLab(db,{date:'2026-09-11',name:'Example test',value:'7.1',unit:'mg/L',referenceLow:2,referenceHigh:9,referenceText:'Range printed on page 2',lab:'Example lab',documentNote:'Discuss at my appointment <script>alert(1)</script>'}).lab;
 assert.equal(lab.value,'7.1');assert.equal(lab.referenceHigh,9);assert.match(lab.documentNote,/<script>/);assert.equal(lab.diagnosis,undefined);assert.equal(lab.flag,undefined);
 assert.throws(()=>saveLab(db,{...lab,referenceLow:10,referenceHigh:2}),/minimum/);assert.equal(getHealth(db).labs.length,1);
 const edited=saveLab(db,{...lab,value:'Not detected',unit:''}).lab;assert.equal(edited.value,'Not detected');assert.equal(getHealth(db).labs.length,1);
});
test('measurements preserve input units and normalize only for chart comparison',t=>{
 const db=fixture(t);const weight=saveMetric(db,{kind:'weight',date:'2026-09-11',value:150,unit:'lb'}).metric;
 assert.equal(weight.value,150);assert.ok(Math.abs(weight.baseValue-68.0388555)<0.000001);assert.equal(weight.unit,'lb');
 saveMetric(db,{kind:'sleep',date:'2026-09-11',value:7.5,unit:'hours'});
 assert.throws(()=>saveMetric(db,{kind:'sleep',date:'2026-09-11',value:25,unit:'hours'}));assert.throws(()=>saveMetric(db,{kind:'weight',date:'2026-09-11',value:70,unit:'hours'}));
 assert.equal(getHealth(db).metrics.length,2);
});
test('plans remain editable, completion is per entry, and groceries retain links and records',t=>{
 const db=fixture(t);let plan=savePlan(db,{title:'My week',weekStart:'2026-09-14',entries:[{date:'2026-09-14',kind:'meal',title:'My chosen lunch'},{date:'2026-09-15',kind:'workout',title:'My chosen activity',details:'As instructed'}]}).plan;
 const meal=plan.entries[0];const grocery=saveGroceryItem(db,{planId:plan.id,entryId:meal.id,name:'Tomatoes',quantity:'3',estimatedCost:4.5}).item;
 setPlanEntryState(db,{id:meal.id,state:'done'});plan=getHealth(db).plans[0];assert.equal(plan.entries[0].state,'done');assert.equal(plan.entries[1].state,'planned');
 savePlan(db,{...plan,title:'Updated week'});assert.equal(getHealth(db).plans.length,1);
 assert.throws(()=>saveGroceryItem(db,{planId:plan.id,entryId:plan.entries[1].id,name:'Not a meal'}),/meal/);
 assert.throws(()=>savePlan(db,{title:'Other plan',weekStart:'2026-09-14',entries:[meal]}),/another plan/);
 deleteHealthRecord(db,{kind:'plan',id:plan.id});const kept=getHealth(db).groceryItems[0];assert.equal(kept.id,grocery.id);assert.equal(kept.planId,null);assert.equal(kept.entryId,null);
 assert.throws(()=>deleteHealthRecord(db,{kind:'lab',id:grocery.id}),/no longer/);assert.equal(getHealth(db).groceryItems.length,1);
});

test('stale edits cannot overwrite newer records or preference changes',t=>{
 const db=fixture(t);const lab=saveLab(db,{date:'2026-09-11',name:'Recorded test',value:'1.2'}).lab;
 const updated=saveLab(db,{...lab,value:'1.3',expectedUpdatedAt:lab.updatedAt}).lab;
 assert.notEqual(updated.updatedAt,lab.updatedAt);
 assert.throws(()=>saveLab(db,{...lab,value:'old value',expectedUpdatedAt:lab.updatedAt}),error=>error.status===409);
 assert.equal(getHealth(db).labs[0].value,'1.3');
 const profile=saveProfile(db,{allergies:'Peanuts'}).profile;saveProfile(db,{allergies:'Peanuts and tree nuts',expectedUpdatedAt:profile.updatedAt});
 assert.throws(()=>saveProfile(db,{allergies:'',expectedUpdatedAt:profile.updatedAt}),error=>error.status===409);
 assert.equal(getHealth(db).profile.allergies,'Peanuts and tree nuts');
 assert.throws(()=>importWalking(db,{csv:'date,steps\n2026-09-11,100',replaceExisting:'false'}));
});
test('removing a meal preserves its groceries and only removes the obsolete meal link',t=>{
 const db=fixture(t);const plan=savePlan(db,{title:'Week',weekStart:'2026-09-14',entries:[{date:'2026-09-14',kind:'meal',title:'Lunch'}]}).plan;
 const item=saveGroceryItem(db,{planId:plan.id,entryId:plan.entries[0].id,name:'Tomatoes',quantity:'3'}).item;
 savePlan(db,{...plan,entries:[],expectedUpdatedAt:plan.updatedAt});
 const saved=getHealth(db).groceryItems[0];assert.equal(saved.id,item.id);assert.equal(saved.name,'Tomatoes');assert.equal(saved.planId,plan.id);assert.equal(saved.entryId,null);
});


test('reviewed plans retain ingredients and activity fields across completion and edits',t=>{
 const db=fixture(t);let plan=savePlan(db,{title:'Reviewed week',weekStart:'2026-09-14',entries:[
  {date:'2026-09-14',kind:'meal',mealSlot:'lunch',title:'Rice bowl',details:'Cook and combine.',ingredients:[{name:'Rice',quantity:100,unit:'g'}]},
  {date:'2026-09-14',kind:'workout',title:'Easy walk',details:'Choose a flat route.',activity:'walking',durationMinutes:15,intensity:'light'},
 ]}).plan;
 assert.equal(plan.entries[0].ingredients[0].quantity,100);assert.equal(plan.entries[0].mealSlot,'lunch');assert.equal(plan.entries[1].durationMinutes,15);
 plan=setPlanEntryState(db,{id:plan.entries[0].id,state:'done'}).plan;assert.equal(plan.entries[0].ingredients[0].name,'Rice');
 plan=savePlan(db,{...plan,title:'Edited week'}).plan;assert.equal(plan.entries[1].activity,'walking');assert.equal(plan.entries[1].intensity,'light');
 const snapshot=JSON.stringify(getHealth(db).plans);
 for(const change of [{ingredients:[{name:'Rice',quantity:-1,unit:'g'}]},{ingredients:[{name:'Rice',quantity:100,unit:'unknown'}]},{mealSlot:'unknown'}])assert.throws(()=>savePlan(db,{...plan,entries:[{...plan.entries[0],...change}]}));
 for(const change of [{durationMinutes:-1},{durationMinutes:1.5},{intensity:'extreme'}])assert.throws(()=>savePlan(db,{...plan,entries:[{...plan.entries[1],...change}]}));
 assert.equal(JSON.stringify(getHealth(db).plans),snapshot);
});
