import test from 'node:test';
import assert from 'node:assert/strict';
import {open,migrate,close,withTransaction,setKV,getKV} from '../core/db.mjs';
import {getHealth,saveProfile} from '../core/health.mjs';
import {saveHealthPlanPreview} from '../core/health-plan-store.mjs';
function fixture(t){const db=open(':memory:');migrate(db);t.after(()=>close(db));saveProfile(db,{goals:'General wellbeing',diet:'none',allergies:'none',exerciseLimitations:'none',householdSize:1});const preview={id:'health_preview_synthetic',profileUpdatedAt:getHealth(db).profile.updatedAt,weekStart:'2026-09-14',title:'Reviewed week',entries:[{date:'2026-09-14',kind:'meal',title:'Oats and apple',details:'Cook oats and slice the apple.',mealSlot:'breakfast',ingredients:[{name:'Apple',quantity:1,unit:'item'}]},{date:'2026-09-14',kind:'workout',title:'Easy walk',details:'Walk at an easy pace.',durationMinutes:15,intensity:'light',activity:'walking'}],groceries:[{name:'Apple',quantity:1,unit:'item',mealRefs:[0]}],assumptions:['A general activity plan.'],sources:[]};return {db,preview};}
test('a reviewed plan and linked groceries save atomically and repeated requests reuse the receipt',t=>{
 const {db,preview}=fixture(t);const first=saveHealthPlanPreview(db,{preview,reviewed:true});assert.equal(first.saved,true);assert.equal(first.ordered,false);assert.equal(first.groceryCount,1);
 const health=getHealth(db);assert.equal(health.plans.length,1);assert.equal(health.groceryItems.length,1);assert.equal(health.groceryItems[0].planId,first.plan.id);assert.equal(health.groceryItems[0].entryId,first.plan.entries[0].id);
 assert.deepEqual(saveHealthPlanPreview(db,{preview,reviewed:true}),first);assert.equal(getHealth(db).groceryItems.length,1);
 assert.throws(()=>saveHealthPlanPreview(db,{preview:{...preview,title:'Different request'},reviewed:true}),/already saved/);
});
test('missing review, changed profile and invalid groceries cannot leave partial plans behind',t=>{
 const {db,preview}=fixture(t);assert.throws(()=>saveHealthPlanPreview(db,{preview}),/Review/);
 assert.throws(()=>saveHealthPlanPreview(db,{preview:{...preview,groceries:[{name:'Apple',quantity:-1,unit:'item'}]},reviewed:true}),/quantity/);assert.equal(getHealth(db).plans.length,0);assert.equal(getHealth(db).groceryItems.length,0);
 saveProfile(db,{goals:'Updated goal',diet:'none',allergies:'none',exerciseLimitations:'none',householdSize:1});assert.throws(()=>saveHealthPlanPreview(db,{preview,reviewed:true}),/preferences changed/);
});
test('nested persistence rollback never commits an inner write or rolls back a recovered outer transaction',t=>{
 const {db}=fixture(t);
 assert.throws(()=>withTransaction(db,()=>{withTransaction(db,()=>setKV(db,'inner','written'));throw Error('rollback');}),/rollback/);assert.equal(getKV(db,'inner'),null);
 withTransaction(db,()=>{setKV(db,'outer','preserved');try{withTransaction(db,()=>{setKV(db,'inner','rollback');throw Error('nested failure');});}catch{}setKV(db,'continued','yes');});assert.equal(getKV(db,'outer'),'preserved');assert.equal(getKV(db,'inner'),null);assert.equal(getKV(db,'continued'),'yes');
});
