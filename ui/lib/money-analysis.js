/** Pure financial summaries. Amounts remain integer cents; no balance or renewal guesses. */
export const PALETTE=['#c4b5fd','#8fc9bd','#deb583','#91b9e0','#df9fa8','#abb786','#c9a4d7','#83bfcc','#d3c5a2','#9aa5bb','#b7ada7','#a3b0da'];
export const isoDay=d=>d.toISOString().slice(0,10);
export function monthList(start,end){
 const valid=x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T12:00:00Z'))&&isoDay(new Date(x+'T12:00:00Z'))===x;
 if(!valid(start)||!valid(end)||start>end)throw new Error('Choose valid dates with the start before the end.');
 const cursor=new Date(start.slice(0,7)+'-01T12:00:00Z'),last=end.slice(0,7),out=[];
 while(isoDay(cursor).slice(0,7)<=last){out.push(isoDay(cursor).slice(0,7));if(out.length>24)throw new Error('Choose a range of up to 24 months.');cursor.setUTCMonth(cursor.getUTCMonth()+1);}
 return out;
}
export function presetRange(preset,today){
 const date=new Date(today+'T12:00:00Z'),first=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1,12));
 if(preset==='month')return {start:isoDay(first),end:today};
 if(preset==='last-month'){const last=new Date(first);last.setUTCDate(0);first.setUTCMonth(first.getUTCMonth()-1);return {start:isoDay(first),end:isoDay(last)};}
 if(preset==='90days'){date.setUTCDate(date.getUTCDate()-89);return {start:isoDay(date),end:today};}
 first.setUTCMonth(first.getUTCMonth()-11);return {start:isoDay(first),end:today};
}
const NAMES=[['ARS INDY','ARS Indy'],['PALMETTO STATE ARMORY','Palmetto State Armory'],['CULINARY DROPOUT','Culinary Dropout'],['CHICK-FIL-A','Chick-fil-A'],['103 TORCHYS','Torchy’s Tacos'],['TORCHYS','Torchy’s Tacos'],['BLUE SUSHI','Blue Sushi'],['HC TAVERN','HC Tavern'],['1933 -','1933 Lounge'],['CRACKER BARREL','Cracker Barrel'],['MCALISTER','McAlister’s'],['ALBASHA','Albasha'],['STARBUCKS','Starbucks'],['JAVA HOUSE','Java House'],['MEIJER','Meijer'],['KROGER','Kroger'],['TRADER JOE','Trader Joe’s'],['TARGET','Target'],['TESLA_US','Tesla'],['GLOBAL-E','Global-e'],['NETFLIX','Netflix'],['SPOTIFY','Spotify'],['UBER ONE','Uber One'],['COMCAST','Xfinity'],['GOODCHOP','GoodChop'],['RYTHM HEALTH','Rythm Health'],['SEPHORA','Sephora'],['MICRO CENTER','Micro Center'],['SP MANSCAPED','Manscaped'],['SP BIGBLANKET','Big Blanket'],['SP DISTURBIA','Disturbia']];
export function merchantName(description){const raw=String(description||'Unknown merchant').replace(/^AplPay\s+/i,'').replace(/^TST\*\s*/i,'');return NAMES.find(([match])=>raw.toUpperCase().includes(match))?.[1]||raw.split(/\s{2,}/)[0].replace(/\s+\d[\d -]*$/,'').trim()||raw;}
export function recurringType(row){
 const c=row.category.toLowerCase();
 if(/possible.*subscription|subscription.*confirm/.test(c))return 'possible';
 if(/subscription|recurring/.test(c))return 'identified';
 return null;
}
const add=(a,b)=>{const n=a+b;if(!Number.isSafeInteger(n))throw new Error('The selected totals are too large. Narrow the date range.');return n;};
export function analyzeMoney(transactions,{start,end,currency}){
 monthList(start,end);
 const rows=transactions.filter(t=>t.date>=start&&t.date<=end&&t.currency===currency);
 const included=rows.filter(t=>t.status!=='excluded'&&t.kind!=='transfer');
 const purchases=included.filter(t=>t.amountCents<0),credits=included.filter(t=>t.amountCents>0);
 const total=purchases.reduce((n,t)=>add(n,-t.amountCents),0),moneyIn=credits.reduce((n,t)=>add(n,t.amountCents),0);
 const categoryMap=new Map(),merchantMap=new Map(),dailyMap=new Map(),monthlyMap=new Map(),subs=new Map();
 for(const t of purchases){
  const amount=-t.amountCents,category=t.category||'Uncategorized',name=merchantName(t.description);
  for(const [map,key,extra] of [[categoryMap,category,{name:category}],[merchantMap,name,{name}],[dailyMap,t.date,{date:t.date}],[monthlyMap,t.date.slice(0,7),{month:t.date.slice(0,7)}]]){
   if(!map.has(key))map.set(key,{...extra,total:0,count:0,rows:[]});const group=map.get(key);group.total=add(group.total,amount);group.count++;group.rows.push(t);
  }
  const type=recurringType(t);
  if(type){const key=JSON.stringify([t.entityId,t.accountId,t.currency,name,type]);if(!subs.has(key))subs.set(key,{name,type,total:0,rows:[]});const sub=subs.get(key);sub.total=add(sub.total,amount);sub.rows.push(t);}
 }
 const dates=rows.map(t=>t.date).sort(),first=dates[0]||start,last=dates.at(-1)||end;
 const days=[];const cursor=new Date(first+'T12:00:00Z');let cumulative=0;
 while(isoDay(cursor)<=last){const date=isoDay(cursor),value=dailyMap.get(date)?.total||0;cumulative=add(cumulative,value);days.push({date,total:value,cumulative,count:dailyMap.get(date)?.count||0});cursor.setUTCDate(cursor.getUTCDate()+1);}
 const categories=[...categoryMap.values()].sort((a,b)=>b.total-a.total).map((c,i)=>({...c,color:PALETTE[i%PALETTE.length],share:total?c.total/total:0}));
 const merchants=[...merchantMap.values()].sort((a,b)=>b.total-a.total),subscriptions=[...subs.values()].map(s=>({...s,rows:s.rows.sort((a,b)=>b.date.localeCompare(a.date))})).sort((a,b)=>a.type.localeCompare(b.type)||b.total-a.total);
 return {rows,purchases,credits,total,moneyIn,net:moneyIn-total,first,last,days,categories,merchants,subscriptions,
  months:monthList(start,end).map(month=>monthlyMap.get(month)||{month,total:0,count:0,rows:[]}),
  subscriptionTotal:subscriptions.filter(s=>s.type==='identified').reduce((n,s)=>add(n,s.total),0),possibleTotal:subscriptions.filter(s=>s.type==='possible').reduce((n,s)=>add(n,s.total),0),
  transfers:rows.filter(t=>t.kind==='transfer'&&t.status!=='excluded'),review:rows.filter(t=>t.status==='review'),
  largest:[...purchases].sort((a,b)=>a.amountCents-b.amountCents)[0]||null,
  biggestDay:[...dailyMap.values()].sort((a,b)=>b.total-a.total)[0]||null,
  activeDays:dailyMap.size,average: purchases.length?Math.round(total/purchases.length):0};
}
export function exportRowsCsv(rows){
 const quote=value=>'"'+String(value??'').replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')+'"';
 return [['Date','Description','Category','Amount','Currency','Kind','Status'],...rows.map(t=>[t.date,t.description,t.category,(t.amountCents/100).toFixed(2),t.currency,t.kind,t.status])].map(row=>row.map(quote).join(',')).join('\r\n');
}
