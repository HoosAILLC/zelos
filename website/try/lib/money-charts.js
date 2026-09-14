import {el,button} from './dom.js';
import {merchantName} from './money-analysis.js';
export const cash=(c,code='USD')=>new Intl.NumberFormat(undefined,{style:'currency',currency:code,maximumFractionDigits:2}).format(c/100);
const OWNER_COLORS={personal:'#7bd6c5',business:'#b9a0ff',unassigned:'#aab2bf'};
const OWNER_NAMES={personal:'Personal',business:'Business',unassigned:'Unassigned'};
const ownerKeys=['personal','business','unassigned'];
const compact=(c,code)=>new Intl.NumberFormat(undefined,{style:'currency',currency:code,notation:'compact',maximumFractionDigits:1}).format(c/100);
export const dateLabel=d=>new Date(d+'T12:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
const small=t=>el('p',{class:'money-muted',text:t});
const heading=(title,subtitle,action)=>el('div',{class:'money-card-head'},[el('div',{},[el('h2',{text:title}),subtitle&&small(subtitle)]),action]);
const card=(title,subtitle,children,action)=>el('section',{class:'money-card'},[heading(title,subtitle,action),...children]);
function svgNode(tag,attrs={},children=[]){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));for(const c of children)n.append(typeof c==='string'?document.createTextNode(c):c);return n;}
function interactive(n,label,onClick){n.setAttribute('tabindex','0');n.setAttribute('role','button');n.setAttribute('aria-label',label);n.append(svgNode('title',{},[label]));n.addEventListener('click',onClick);n.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onClick();}});return n;}
export function spendingChart(a,{currency,mode,onMode,onDay,ownerFor}) {
 const tip=el('div',{class:'money-chart-readout',text:'Hover or focus a date for exact amounts. Select it to see purchases.'});
 const toggles=el('div',{class:'money-segment'},[['cumulative','Cumulative'],['daily','Daily']].map(([key,label])=>button(label,{'aria-pressed':mode===key?'true':'false',onClick:()=>onMode(key)})));
 const daily=new Map();
 if(ownerFor) for(const t of a.purchases) { const key=ownerFor(t.entityId),value=daily.get(t.date)||{};value[key]=(value[key]||0)-t.amountCents;daily.set(t.date,value); }
 const running={personal:0,business:0,unassigned:0};
 const data=a.days.map(d=>{const values={};for(const key of ownerKeys){const spend=daily.get(d.date)?.[key]||0;running[key]+=spend;values[key]=mode==='daily'?spend:running[key];}return {...d,values};});
 const keys=ownerFor?ownerKeys.filter(key=>key!=='unassigned'||running[key]>0):['total'];
 const amount=(d,key)=>key==='total'?(mode==='daily'?d.total:d.cumulative):d.values[key];
 const color=key=>OWNER_COLORS[key]||'#c4b5fd';
 const w=760,h=280,L=64,R=17,T=20,B=38,inner=w-L-R,base=h-B,max=Math.max(100,...data.flatMap(d=>keys.map(key=>amount(d,key))));
 const svg=svgNode('svg',{viewBox:`0 0 ${w} ${h}`,class:'money-line',role:'group','aria-label':`${mode==='daily'?'Daily':'Cumulative'} recorded spending${ownerFor?' by Personal and Business':''} in ${currency}`});
 for(let i=0;i<=4;i++){const y=T+(base-T)*i/4;svg.appendChild(svgNode('line',{x1:L,y1:y,x2:w-R,y2:y,stroke:'currentColor','stroke-opacity':'.11','stroke-dasharray':'3 6'}));svg.appendChild(svgNode('text',{x:L-10,y:y+4,'text-anchor':'end',class:'money-axis'},[compact(Math.round(max*(1-i/4)),currency)]));}
 const x=i=>L+(data.length===1?inner/2:i/(data.length-1)*inner),y=n=>base-n/max*(base-T);
 for(const key of keys) if(data.length) {
  const line=data.map((d,i)=>`${i?'L':'M'}${x(i).toFixed(2)},${y(amount(d,key)).toFixed(2)}`).join(' ');
  svg.appendChild(svgNode('path',{d:`M${x(0)},${base} ${line.replace(/^M/,'L')} L${x(data.length-1)},${base} Z`,fill:color(key),'fill-opacity':ownerFor?'.035':'.08','aria-hidden':'true'}));
  svg.appendChild(svgNode('path',{d:line,fill:'none',stroke:color(key),'stroke-width':2.7,'stroke-linejoin':'round','stroke-dasharray':key==='business'?'7 4':'none','aria-hidden':'true'}));
 }
 // One focus target per date reads both series and opens the same transaction drilldown.
 data.forEach((d,i)=>{
  const label=`${dateLabel(d.date)}: ${keys.map(key=>`${OWNER_NAMES[key]||'Total'} ${cash(amount(d,key),currency)}`).join('; ')} ${mode==='daily'?'spent':'cumulative'}; ${d.count} purchases that day`;
  const group=interactive(svgNode('g',{class:'money-date-point'}),label,()=>onDay(d.date));
  for(const key of keys)group.appendChild(svgNode('circle',{cx:x(i),cy:y(amount(d,key)),r:data.length>100?2.5:4,fill:color(key),'fill-opacity':d.total?1:.12,'aria-hidden':'true'}));
  group.addEventListener('mouseenter',()=>{tip.textContent=label;});group.addEventListener('focus',()=>{tip.textContent=label;});svg.appendChild(group);
 });
 if(data.length)for(const i of new Set([0,Math.floor((data.length-1)/3),Math.floor((data.length-1)*2/3),data.length-1]))svg.appendChild(svgNode('text',{x:x(i),y:h-9,'text-anchor':i===0?'start':i===data.length-1?'end':'middle',class:'money-axis'},[dateLabel(data[i].date)]));
 const legend=ownerFor&&el('div',{class:'money-owner-key'},keys.map(key=>el('span',{'data-owner':key,style:{'--owner-color':color(key)}},[el('i',{class:'money-series-key '+(key==='business'?'is-dashed':''),'aria-hidden':'true'}),el('span',{text:OWNER_NAMES[key]}),el('strong',{text:cash(running[key],currency)})])));
 return card('The shape of your spending',ownerFor?'Personal and Business follow the same dates and scale.':a.rows.length?`Recorded activity · ${dateLabel(a.first)} – ${dateLabel(a.last)}`:'Your imported transactions will draw this chart.',[el('div',{class:'money-line-wrap'},[ownerFor&&el('div',{class:'money-legend-caption',text:'Period totals'}),legend,svg,tip])],toggles);
}
function ownedAmounts(rows,ownerFor){const values={personal:0,business:0,unassigned:0};for(const t of rows)values[ownerFor(t.entityId)]-=t.amountCents;return values;}
function ownedTrack(values,total,max=total){return el('span',{class:'money-owned-track','aria-hidden':'true'},ownerKeys.map(key=>el('span',{'data-owner':key,style:{width:`${max?values[key]/max*100:0}%`,background:OWNER_COLORS[key]}})));}
export function ownedCategories(a,currency,onCategory,ownerFor){
 const max=Math.max(1,...a.categories.map(c=>c.total));
 const row=c=>{const values=ownedAmounts(c.rows,ownerFor);return button(el('span',{class:'money-owned-category'},[
  el('span',{class:'money-owned-category-head'},[el('span',{text:c.name}),el('strong',{text:cash(c.total,currency)})]),ownedTrack(values,c.total,max),
  el('span',{class:'money-owned-category-detail',text:ownerKeys.filter(k=>values[k]).map(k=>`${OWNER_NAMES[k]} ${cash(values[k],currency)}`).join(' · ')})
 ]),{'aria-label':`${c.name}: ${ownerKeys.filter(k=>values[k]).map(k=>`${OWNER_NAMES[k]} ${cash(values[k],currency)}`).join('; ')}. View purchases.`,onClick:()=>onCategory(c.name)});};
 const extra=a.categories.slice(8);
 return card('Where it went','Categories split by Personal and Business. Select one to inspect purchases.',[
  el('div',{class:'money-owned-categories'},a.categories.slice(0,8).map(row)),
  extra.length>0&&el('details',{class:'money-category-more'},[el('summary',{text:`Show ${extra.length} more categories`}),el('div',{class:'money-owned-categories'},extra.map(row))]),
  !a.categories.length&&small('No spending in this period.')
 ]);
}
export function categoryChart(a,currency,onCategory){
 const ring=svgNode('svg',{viewBox:'0 0 210 210',class:'money-ring',role:'group','aria-label':`Spending mix: ${a.categories.map(c=>`${c.name} ${cash(c.total,currency)}`).join('; ')}`});
 const radius=77,circum=2*Math.PI*radius;let offset=0;
 ring.append(svgNode('circle',{cx:105,cy:105,r:radius,fill:'none',stroke:'currentColor','stroke-opacity':'.07','stroke-width':25}));
 for(const c of a.categories){const length=c.share*circum;const arc=interactive(svgNode('circle',{cx:105,cy:105,r:radius,fill:'none',stroke:c.color,'stroke-width':25,'stroke-dasharray':`${Math.max(.1,length-2)} ${circum-Math.max(.1,length-2)}`,'stroke-dashoffset':-offset,transform:'rotate(-90 105 105)',class:'money-ring-segment'}),`${c.name}: ${cash(c.total,currency)}, ${(c.share*100).toFixed(1)} percent`,()=>onCategory(c.name));ring.append(arc);offset+=length;}
 ring.append(svgNode('text',{x:105,y:99,'text-anchor':'middle',class:'money-ring-number'},[String(a.categories.length)]),svgNode('text',{x:105,y:124,'text-anchor':'middle',class:'money-axis'},['categories']));
 return card('Where it went','Select a category to inspect its purchases.',[ring,el('div',{class:'money-legend'},a.categories.map(c=>button(el('span',{class:'money-legend-row'},[el('i',{style:{background:c.color},'aria-hidden':'true'}),el('span',{text:c.name}),el('small',{text:`${(c.share*100).toFixed(1)}%`}),el('strong',{text:cash(c.total,currency)})]),{onClick:()=>onCategory(c.name)}))),!a.categories.length&&small('No spending in this period.')].filter(Boolean));
}
export function monthlyChart(a,currency,onMonth){
 const max=Math.max(1,...a.months.map(m=>m.total));
 return card('Month by month','Purchases by transaction date. Empty months have no recorded purchases.',[el('div',{class:'money-month-bars'},a.months.map(m=>{const label=new Date(m.month+'-01T12:00:00Z').toLocaleDateString(undefined,{month:'short',year:'2-digit',timeZone:'UTC'});return button(el('span',{class:'money-month-column'},[el('span',{class:'money-month-value',text:m.total?compact(m.total,currency):'—'}),el('span',{class:'money-month-track'},el('span',{class:'money-month-fill',style:{height:`${m.total?Math.max(1.5,m.total/max*100):0}%`}})),el('span',{class:'money-month-label',text:label})]),{'aria-label':`${label}: ${cash(m.total,currency)}, ${m.count} purchases. View month.`,onClick:()=>onMonth(m.month)});})),small('Includes recorded purchases, reviewed or awaiting review. Transfers and excluded entries are omitted; pending bank charges are not imported.')]);
}
export function merchantsChart(a,currency,onMerchant,ownerFor){
 const rows=a.merchants.slice(0,8),max=Math.max(1,rows[0]?.total||0);
 return card('Your biggest merchants',`${a.merchants.length} merchants in this period · select one to explore`,[el('div',{class:'money-merchant-list'},rows.map((m,i)=>button(el('span',{class:'money-merchant-row'},[el('span',{class:'money-rank',text:String(i+1).padStart(2,'0')}),el('span',{class:'money-merchant-main'},[el('span',{class:'money-merchant-label'},[el('strong',{text:m.name}),el('small',{text:`${m.count} purchase${m.count===1?'':'s'}`})]),ownerFor?ownedTrack(ownedAmounts(m.rows,ownerFor),m.total,max):el('span',{class:'money-merchant-track'},el('span',{style:{width:`${m.total/max*100}%`}}))]),el('strong',{text:cash(m.total,currency)})]),{'aria-label':ownerFor?`${m.name}: ${ownerKeys.filter(k=>ownedAmounts(m.rows,ownerFor)[k]).map(k=>`${OWNER_NAMES[k]} ${cash(ownedAmounts(m.rows,ownerFor)[k],currency)}`).join('; ')}. View purchases.`:null,onClick:()=>onMerchant(m.name)})))]);
}
export function insights(a,currency){
 if(!a.purchases.length)return null;
 const largest=a.largest;return el('div',{class:'money-insights'},[
 el('article',{},[el('span',{class:'money-eyebrow',text:'Largest purchase'}),el('strong',{text:cash(-largest.amountCents,currency)}),small(`${merchantName(largest.description)} · ${dateLabel(largest.date)}`),el('span',{class:'money-insight-foot',text:`${(-largest.amountCents/a.total*100).toFixed(1)}% of period spending`})]),
 el('article',{},[el('span',{class:'money-eyebrow',text:'Busiest spending day'}),el('strong',{text:cash(a.biggestDay.total,currency)}),small(`${dateLabel(a.biggestDay.date)} · ${a.biggestDay.count} purchases`),el('span',{class:'money-insight-foot',text:'Based on recorded transaction dates'})]),
 el('article',{},[el('span',{class:'money-eyebrow',text:'Spending days'}),el('strong',{text:String(a.activeDays)}),small(`${a.purchases.length} purchases in the recorded activity`),el('span',{class:'money-insight-foot',text:'Days with at least one recorded purchase'})])]);
}
export function subscriptionPanel(a,currency,onEdit){
 const known=a.subscriptions.filter(s=>s.type==='identified'),possible=a.subscriptions.filter(s=>s.type==='possible');
 const group=(title,subtitle,rows)=>el('section',{class:'money-sub-group'},[heading(title,subtitle),el('div',{class:'money-sub-grid'},rows.map(s=>el('article',{class:'money-sub-card'},[
 el('div',{class:'money-sub-top'},[el('span',{class:'money-service-avatar','aria-hidden':'true',text:s.name.slice(0,2).toUpperCase()}),el('div',{},[el('h3',{text:s.name}),el('span',{class:`money-pill ${s.type==='possible'?'is-pending':''}`,text:s.type==='possible'?'Needs confirmation':'Categorized as recurring'})])]),
 el('strong',{class:'money-sub-amount',text:cash(s.total,currency)}),small(`${s.rows.length} charge${s.rows.length===1?'':'s'} in selected period`),
 el('div',{class:'money-sub-charges'},s.rows.map(t=>el('div',{},[el('span',{text:dateLabel(t.date)}),el('strong',{text:cash(-t.amountCents,currency)}),button('Review',{class:'btn quiet','aria-label':`Review ${s.name} charge on ${t.date}`,onClick:()=>onEdit(t)})]))),
 small('Renewal date and billing frequency are not recorded.')
 ])))]);
 return el('div',{class:'money-subscriptions'},[
 el('section',{class:'money-sub-banner'},[el('div',{},[el('span',{class:'money-eyebrow',text:'Your recurring spending'}),el('h2',{text:cash(a.subscriptionTotal,currency)}),small(`${known.length} services categorized as subscriptions or recurring bills`)]),el('div',{},[el('span',{class:'money-eyebrow',text:'Possible subscriptions'}),el('strong',{text:cash(a.possibleTotal,currency)}),small(`${possible.length} services to confirm`)])]),
 el('p',{class:'money-coverage',text:'These are charges found in the selected dates, not a forecast of monthly bills. One statement cannot establish every active subscription or its renewal schedule.'}),
 group('Subscriptions & recurring bills','Includes memberships, streaming, and recurring utilities.',known),!known.length&&small('No categorized subscription charges in this period.'),
 possible.length&&group('Worth a closer look','Check these charges before treating them as ongoing commitments.',possible)
 ].filter(Boolean));
}
