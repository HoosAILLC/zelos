import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../website/campaign.js', import.meta.url), 'utf8');
function page(pathname = '/', hash = '') {
  const events = new Map(), redirects = [];
  const location = {pathname, hash, search:'', replace: target => redirects.push(target)};
  const document = {
    documentElement:{classList:{add(){}}},
    querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){},
  };
  const window = {addEventListener:(name,handler)=>events.set(name,handler), matchMedia:()=>({addEventListener(){}})};
  vm.runInNewContext(script,{document,window,location,URLSearchParams});
  return {location,redirects,changeHash(hash){location.hash=hash;events.get('hashchange')();}};
}

test('old bookmarks reach the new pages on first load',()=>{
  assert.deepEqual(page('/','#download').redirects,['/download']);
  assert.deepEqual(page('/index.html','#smart-glasses').redirects,['/vision#smart-glasses']);
  assert.deepEqual(page('/','#feature-groceries').redirects,['/features#feature-groceries']);
});

test('old bookmarks also work when the homepage is already open',()=>{
  const home=page();
  home.changeHash('#see');
  home.changeHash('#safe');
  assert.deepEqual(home.redirects,['/features#see','/download#safe']);
});

test('current homepage anchors and anchors on other pages stay in place',()=>{
  for(const hash of ['#new','#privacy','#main','#unknown']) assert.deepEqual(page('/',hash).redirects,[]);
  const features=page('/features','#see');
  features.changeHash('#feature-groceries');
  assert.deepEqual(features.redirects,[]);
});
