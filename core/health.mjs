/** Private health records. Stores user-entered facts and plans; no medical inference or ordering. */
import { randomUUID } from 'node:crypto';

export class HealthError extends Error {
  constructor(status, message) { super(message); this.name = 'HealthError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new HealthError(status, message); };
const now = previous => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Provide a health record.'); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const text = (value, label, max = 2000, required = false) => {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\0')) fail(`${label} is missing or too long.`);
  return value.trim();
};
const number = (value, label, min, max, optional = false) => {
  const empty = value == null || (typeof value === 'string' && !value.trim());
  if (optional && empty) return null;
  if (empty || !['string','number'].includes(typeof value)) fail(`${label} must be a number.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) fail(`${label} must be between ${min} and ${max}.`);
  return result;
};
const choice = (value, allowed, label) => allowed.includes(value) ? value : fail(`Choose a valid ${label}.`);
const id = value => text(value, 'Record ID', 150, true);
export function healthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Use a date in YYYY-MM-DD format.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('Choose a real calendar date.');
  return value;
}

export function migrateHealth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS health_profile (
    id INTEGER PRIMARY KEY CHECK(id = 1), data_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS health_records (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('walking','lab','metric','plan','grocery')),
    record_date TEXT, data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS health_records_kind_date ON health_records(kind,record_date);`);
}
const decode = row => row ? { ...JSON.parse(row.data_json), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at } : null;
function record(db, kind, key, required = true) {
  const value = decode(db.prepare('SELECT * FROM health_records WHERE id = ? AND kind = ?').get(id(key), kind));
  if (!value && required) fail('This health record is no longer available.', 404);
  return value;
}
function put(db, kind, value, date = null) {
  const existing = db.prepare('SELECT kind,created_at,updated_at FROM health_records WHERE id = ?').get(value.id);
  if (existing && existing.kind !== kind) fail('That record ID belongs to a different type of health record.', 409);
  const stamp = now(existing?.updated_at);
  db.prepare(`INSERT INTO health_records(id,kind,record_date,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET record_date=excluded.record_date,data_json=excluded.data_json,updated_at=excluded.updated_at`)
    .run(value.id, kind, date, JSON.stringify(value), existing?.created_at || stamp, stamp);
  return record(db, kind, value.id);
}
function unchanged(db, kind, input) {
  if (!input.id || !input.expectedUpdatedAt) return;
  if (record(db,kind,input.id).updatedAt !== input.expectedUpdatedAt) fail('This record changed in another view. Open its latest version before saving again.',409);
}
const defaultProfile = () => ({ goals: '', diet: '', allergies: '', exerciseLimitations: '', weeklyBudget: null, currency: 'USD', householdSize: 1 });
export function getHealth(db) {
  const saved = db.prepare('SELECT * FROM health_profile WHERE id=1').get();
  const rows = db.prepare('SELECT * FROM health_records ORDER BY record_date DESC,created_at DESC,id').all();
  const byKind = kind => rows.filter(row => row.kind === kind).map(decode);
  return { profile: { ...defaultProfile(), ...(saved ? JSON.parse(saved.data_json) : {}), updatedAt: saved?.updated_at || null },
    walking: byKind('walking'), labs: byKind('lab'), metrics: byKind('metric'), plans: byKind('plan'), groceryItems: byKind('grocery') };
}
export function saveProfile(db, input) {
  object(input);
  const previous = getHealth(db).profile;
  if(input.expectedUpdatedAt && input.expectedUpdatedAt !== previous.updatedAt)fail('Your preferences changed in another view. Reload them before saving again.',409);
  const profile = {};
  for (const key of ['goals','diet','allergies','exerciseLimitations']) profile[key] = text(own(input,key) ? input[key] : previous[key], key, 4000);
  profile.weeklyBudget = number(own(input,'weeklyBudget') ? input.weeklyBudget : previous.weeklyBudget, 'Weekly grocery budget', 0, 1000000, true);
  profile.currency = text(input.currency ?? previous.currency, 'Currency', 3, true).toUpperCase();
  if (!/^[A-Z]{3}$/.test(profile.currency)) fail('Use a three-letter currency code, such as USD.');
  profile.householdSize = number(input.householdSize ?? previous.householdSize, 'Household size', 1, 100);
  if (!Number.isInteger(profile.householdSize)) fail('Household size must be a whole number.');
  const updatedAt = now(previous.updatedAt);
  db.prepare('INSERT INTO health_profile(id,data_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at')
    .run(JSON.stringify(profile), updatedAt);
  return { profile: { ...profile, updatedAt } };
}
function walkingValue(input, source = 'manual') {
  const date = healthDate(input.date);
  const steps = number(input.steps, 'Steps', 0, 1000000, true);
  if (steps !== null && !Number.isInteger(steps)) fail('Steps must be a whole number.');
  const distance = number(input.distance, 'Distance', 0, 10000, true);
  const distanceUnit = choice(input.distanceUnit || 'km', ['km','mi'], 'distance unit');
  if (steps === null && distance === null) fail('Add a step count or distance.');
  return { id: input.id ? id(input.id) : `walking_${date}`, date, steps, distance, distanceUnit,
    distanceKm: distance === null ? null : Number((distance * (distanceUnit === 'mi' ? 1.609344 : 1)).toFixed(6)),
    note: text(input.note, 'Walking note'), source: text(source, 'Import source', 200) };
}
export function saveWalking(db, input) {
  object(input);
  unchanged(db,'walking',input);
  const value = walkingValue(input);
  const collision = db.prepare("SELECT id FROM health_records WHERE kind='walking' AND record_date=? AND id<>?").get(value.date,value.id);
  if (collision) fail('A walking record already exists for that date. Edit it instead.',409);
  return { walking: put(db,'walking',value,value.date) };
}
function csvRows(csv) {
  text(csv,'CSV',2000000,true);
  const rows = []; let row = [], cell = '', quoted = false;
  for (let index=0; index<csv.length; index++) {
    const ch=csv[index];
    if (ch==='"') { if (quoted && csv[index+1]==='"') {cell+='"';index++;} else if (quoted || cell==='') quoted=!quoted; else fail('The CSV has an unexpected quote.'); }
    else if (!quoted && (ch===',' || ch==='\n' || ch==='\r')) {
      row.push(cell);cell='';
      if(ch!==',') { if(row.some(value=>value.trim())) rows.push(row);row=[];if(ch==='\r'&&csv[index+1]==='\n')index++; }
    } else cell+=ch;
  }
  if(quoted)fail('The CSV has an unclosed quote.');
  row.push(cell);if(row.some(value=>value.trim()))rows.push(row);
  if(rows.length>10001)fail('Import at most 10,000 daily records at a time.');
  return rows;
}
export function importWalking(db, input) {
  object(input);
  if(own(input,'replaceExisting') && typeof input.replaceExisting !== 'boolean')fail('Choose whether to replace existing dates.');
  const rows=csvRows(input.csv); if(rows.length<2)fail('The CSV needs a header and at least one record.');
  const headers=rows.shift().map(value=>value.replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[ _-]/g,''));
  if(new Set(headers).size!==headers.length)fail('The CSV has duplicate column names.');
  const index=key=>headers.indexOf(key);
  if(index('date')<0 || (index('steps')<0&&index('distance')<0))fail('Use CSV columns date,steps,distance,distance_unit. Steps or distance may be blank.');
  const source=text(input.source || 'CSV import','Import source',200);
  const values=rows.map((row,i)=>{
    if(row.length!==headers.length)fail(`CSV row ${i+2} has a different number of columns.`);
    const read=key=>index(key)<0?'':row[index(key)].trim();
    return walkingValue({date:read('date'),steps:read('steps'),distance:read('distance'),distanceUnit:read('distanceunit')||'km',note:read('note')},source);
  });
  if(new Set(values.map(value=>value.date)).size!==values.length)fail('The CSV contains more than one record for a date. Combine daily totals before importing.');
  let imported=0,skipped=0;
  db.exec('SAVEPOINT health_import');
  try {
    for(const value of values) {
      const existing=decode(db.prepare("SELECT * FROM health_records WHERE kind='walking' AND record_date=?").get(value.date));
      if(existing && !input.replaceExisting){skipped++;continue;}
      if(existing)value.id=existing.id;
      put(db,'walking',value,value.date);imported++;
    }
    db.exec('RELEASE health_import');
  } catch(error){db.exec('ROLLBACK TO health_import; RELEASE health_import');throw error;}
  return {imported,skipped};
}
export function saveLab(db,input) {
  object(input);
  unchanged(db,'lab',input);
  if(!['string','number'].includes(typeof input.value) || (typeof input.value==='number'&&!Number.isFinite(input.value)))fail('Enter the result as printed on the lab report.');
  const value={id:input.id?id(input.id):randomUUID(),date:healthDate(input.date),name:text(input.name,'Test name',200,true),
    value:text(String(input.value),'Result',200,true),unit:text(input.unit,'Unit',80),
    referenceLow:number(input.referenceLow,'Reference minimum',-1e12,1e12,true),referenceHigh:number(input.referenceHigh,'Reference maximum',-1e12,1e12,true),
    referenceText:text(input.referenceText,'Lab reference text',1000),lab:text(input.lab,'Lab',200),documentNote:text(input.documentNote,'Document note',6000)};
  if(value.referenceLow!==null&&value.referenceHigh!==null&&value.referenceLow>value.referenceHigh)fail('Reference minimum cannot exceed the maximum.');
  return {lab:put(db,'lab',value,value.date)};
}
export function saveMetric(db,input) {
  object(input);
  unchanged(db,'metric',input);
  const kind=choice(input.kind,['weight','sleep'],'measurement');
  const unit=choice(input.unit,kind==='weight'?['kg','lb']:['hours'],'measurement unit');
  const value=number(input.value,kind==='weight'?'Weight':'Sleep',kind==='weight'?0.01:0,kind==='weight'?2200:24);
  const entry={id:input.id?id(input.id):randomUUID(),date:healthDate(input.date),kind,value,unit,
    baseValue:kind==='weight'&&unit==='lb'?Number((value*0.45359237).toFixed(6)):value,note:text(input.note,'Measurement note')};
  return {metric:put(db,'metric',entry,entry.date)};
}
export function savePlan(db,input) {
  object(input);
  unchanged(db,'plan',input);
  const planId=input.id?id(input.id):randomUUID();
  if(!Array.isArray(input.entries)||input.entries.length>200)fail('A plan can contain up to 200 meals and workouts.');
  const entries=input.entries.map(entry=>{
    object(entry);
    const saved={id:entry.id?id(entry.id):randomUUID(),date:healthDate(entry.date),
      kind:choice(entry.kind,['meal','workout'],'plan entry'),title:text(entry.title,'Meal or workout',200,true),
      details:text(entry.details,'Plan details',4000),state:choice(entry.state||'planned',['planned','done','skipped'],'completion state')};
    if(saved.kind==='meal'){
      if(own(entry,'mealSlot'))saved.mealSlot=choice(entry.mealSlot,['breakfast','lunch','dinner','snack'],'meal time');
      if(own(entry,'ingredients')){
        if(!Array.isArray(entry.ingredients)||entry.ingredients.length>40)fail('A meal can contain up to 40 ingredients.');
        saved.ingredients=entry.ingredients.map(ingredient=>{object(ingredient);return {name:text(ingredient.name,'Ingredient',200,true),
          quantity:number(ingredient.quantity,'Ingredient quantity',0.01,100000),unit:choice(ingredient.unit,['g','kg','ml','l','tsp','tbsp','cup','item'],'ingredient unit')};});
      }
    }else{
      if(own(entry,'durationMinutes')){saved.durationMinutes=number(entry.durationMinutes,'Activity duration',0,1440);if(!Number.isInteger(saved.durationMinutes))fail('Activity duration must be a whole number of minutes.');}
      if(own(entry,'intensity'))saved.intensity=choice(entry.intensity,['rest','light','moderate','vigorous'],'activity intensity');
      if(own(entry,'activity'))saved.activity=text(entry.activity,'Activity',100,true);
    }
    return saved;
  });
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length)fail('Plan entries must have different IDs.');
  const otherIds = new Set(db.prepare("SELECT data_json FROM health_records WHERE kind='plan' AND id<>?").all(planId).flatMap(row=>JSON.parse(row.data_json).entries.map(entry=>entry.id)));
  if(entries.some(entry=>otherIds.has(entry.id)))fail('That entry belongs to another plan.',409);
  const plan={id:planId,title:text(input.title,'Plan title',200,true),weekStart:healthDate(input.weekStart),note:text(input.note,'Plan note',4000),entries};
  db.exec('SAVEPOINT health_plan');
  try {
    const saved=put(db,'plan',plan,plan.weekStart);
    const mealIds=new Set(entries.filter(entry=>entry.kind==='meal').map(entry=>entry.id));
    for(const row of db.prepare("SELECT * FROM health_records WHERE kind='grocery'").all()){
      const item=decode(row);if(item.planId===planId&&item.entryId&&!mealIds.has(item.entryId))put(db,'grocery',{...item,entryId:null});
    }
    db.exec('RELEASE health_plan');return {plan:saved};
  }catch(error){db.exec('ROLLBACK TO health_plan; RELEASE health_plan');throw error;}
}
export function setPlanEntryState(db,input) {
  object(input);
  const entryId=id(input.id); const state=choice(input.state,['planned','done','skipped'],'completion state');
  for(const row of db.prepare("SELECT * FROM health_records WHERE kind='plan'").all()) {
    const plan=decode(row);const entry=plan.entries.find(item=>item.id===entryId);
    if(!entry)continue;entry.state=state;return {plan:put(db,'plan',plan,plan.weekStart)};
  }
  fail('This plan entry is no longer available.',404);
}
export function saveGroceryItem(db,input) {
  object(input);
  unchanged(db,'grocery',input);
  const planId=input.planId?id(input.planId):null;
  const entryId=input.entryId?id(input.entryId):null;
  const plan=planId?record(db,'plan',planId):null;
  if(entryId&&!plan?.entries.some(entry=>entry.id===entryId&&entry.kind==='meal'))fail('Link groceries to a meal in the selected plan.');
  const item={id:input.id?id(input.id):randomUUID(),planId,entryId,name:text(input.name,'Grocery item',200,true),
    quantity:text(input.quantity,'Quantity',100),estimatedCost:number(input.estimatedCost,'Estimated cost',0,1000000,true),
    state:choice(input.state||'needed',['needed','have','bought'],'grocery state')};
  return {item:put(db,'grocery',item)};
}
export function deleteHealthRecord(db,input) {
  object(input);
  const kind=choice(input.kind,['walking','lab','metric','plan','grocery'],'record type');const key=id(input.id);
  record(db,kind,key);
  if(kind==='plan') {
    for(const row of db.prepare("SELECT * FROM health_records WHERE kind='grocery'").all()) {
      const item=decode(row);if(item.planId===key)put(db,'grocery',{...item,planId:null,entryId:null});
    }
  }
  db.prepare('DELETE FROM health_records WHERE id=? AND kind=?').run(key,kind);
  return {ok:true};
}
