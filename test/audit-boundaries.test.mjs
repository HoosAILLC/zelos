import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readRouterTable } from './router-table.mjs';
import { stripFixedNavigation } from './ui-navigation.mjs';
process.env.ZELOS_SECRETS_BACKEND='encrypted-file';
const source=fs.readFileSync(new URL('../core/server.mjs',import.meta.url),'utf8');
const remote=/https?:\/\//;
test('route probes preserve escaped literal dots and refuse unsupported regex syntax',()=>{
 assert.ok(readRouterTable(source).some(([method,url])=>method==='GET'&&url==='/api/assistant/jobs/probe.id-1/report.pdf'));
 const literal=source.replace(String.raw`/^\/api\/shopping$/`,String.raw`/^\/api\/audit\.json$/`);
 assert.notEqual(literal,source);assert.ok(readRouterTable(literal).some(([method,url])=>method==='GET'&&url==='/api/audit.json'));
 const unsupported=source.replace(String.raw`/^\/api\/shopping$/`,String.raw`/^\/api\/audit\d+$/`);
 assert.throws(()=>readRouterTable(unsupported),/cannot turn/);
});
test('Health navigation exceptions cannot conceal resource loads or a wider URL allowlist',()=>{
 const original=fs.readFileSync(new URL('../ui/views/health.js',import.meta.url),'utf8');
 assert.doesNotMatch(stripFixedNavigation('ui/views/health.js',original),remote);
 assert.throws(()=>stripFixedNavigation('ui/views/health.js',original+'\nfetch([...sourceURLs][0]);'),/may only be declared/);
 assert.throws(()=>stripFixedNavigation('ui/views/health.js',original.replace('https://www.who.int/news-room/fact-sheets/detail/healthy-diet','https://www.who.int/other')),/exact three/);
 const extra=original+"\nel('img',{src:'https://www.who.int/news-room/fact-sheets/detail/healthy-diet'});";
 assert.match(stripFixedNavigation('ui/views/health.js',extra),remote);
 assert.equal(stripFixedNavigation('ui/other.js',original),original);
});
test('Shopping exception is one exact protected anchor, not an exempt domain',()=>{
 const original=fs.readFileSync(new URL('../ui/views/shopping.js',import.meta.url),'utf8');
 assert.doesNotMatch(stripFixedNavigation('ui/views/shopping.js',original),remote);
 assert.throws(()=>stripFixedNavigation('ui/views/shopping.js',original.replace("rel: 'noopener noreferrer'","rel: 'opener'")),/exact developer-key/);
 assert.match(stripFixedNavigation('ui/views/shopping.js',original+"\nfetch('https://docs.instacart.com/other');"),remote);
});

test('Brave setup exception remains an exact click-only key-management link',()=>{
 const original=fs.readFileSync(new URL('../ui/views/ask.js',import.meta.url),'utf8');
 assert.throws(()=>stripFixedNavigation('ui/views/ask.js',original.replace('https://api-dashboard.search.brave.com/app/keys','https://api-dashboard.search.brave.com/other')),/exact Brave-key/);
 assert.match(stripFixedNavigation('ui/views/ask.js',original+"\nfetch('https://api-dashboard.search.brave.com/app/keys');"),remote);
});


test('all grouped Plaid actions are covered by the derived authorization probes',()=>{
 const routes=readRouterTable(source);
 const actions=routes.filter(([method,url])=>method==='POST'&&url.startsWith('/api/finance/plaid/')).map(([,url])=>url.split('/').at(-1)).sort();
 assert.deepEqual(actions,['complete','configure','disconnect','map','start','sync']);
 const missing=source.replace(String.raw`(configure|start|complete|map|sync|disconnect)`,String.raw`(configure|start|complete|map|sync|disconnect)?`);
 assert.throws(()=>readRouterTable(missing),/cannot turn/);
});

test('Plaid setup links are exact protected navigation, with no file or domain exemption',()=>{
 const original=fs.readFileSync(new URL('../ui/lib/bank-link.js',import.meta.url),'utf8');
 assert.doesNotMatch(stripFixedNavigation('ui/lib/bank-link.js',original),remote);
 assert.throws(()=>stripFixedNavigation('ui/lib/bank-link.js',original.replace("rel:'noopener noreferrer'","rel:'opener'")),/protected anchor/);
 assert.throws(()=>stripFixedNavigation('ui/lib/bank-link.js',original.replace('https://dashboard.plaid.com/','https://dashboard.plaid.com/other')),/exact reviewed/);
 assert.match(stripFixedNavigation('ui/lib/bank-link.js',original+"\nfetch('https://dashboard.plaid.com/');"),remote);
 assert.match(stripFixedNavigation('ui/lib/bank-link.js',original+"\nel('img',{src:'https://support.plaid.com/tracker'});"),remote);
});
