import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../website/js/films.js', import.meta.url), 'utf8');
function fixture(portrait = false) {
  const listeners = new Map();
  const phone = {matches:portrait, addEventListener:(_,fn)=>listeners.set('resize',fn)};
  const players = ['morning','dinner'].map(name => ({
    dataset:{filmLandscape:`/${name}.mp4`,filmPortrait:`/${name}-portrait.mp4`,posterLandscape:`/${name}.jpg`,posterPortrait:`/${name}-portrait.jpg`},
    paused:true, currentTime:0, loads:0, events:new Map(),
    load(){this.loads++;}, pause(){this.paused=true;},
    addEventListener(name,fn){this.events.set(name,fn);},
  }));
  const document = {hidden:false,querySelectorAll:()=>players,addEventListener:(name,fn)=>listeners.set(name,fn)};
  vm.runInNewContext(source,{document,window:{matchMedia:()=>phone}});
  return {players,document,resize(matches){phone.matches=matches;listeners.get('resize')();},hide(){document.hidden=true;listeners.get('visibilitychange')();}};
}

test('phones receive the portrait edit and matching poster before playback',()=>{
  const f=fixture(true);
  assert.equal(f.players[0].src,'/morning-portrait.mp4');
  assert.equal(f.players[0].poster,'/morning-portrait.jpg');
  assert.equal(f.players[1].src,'/dinner-portrait.mp4');
  f.resize(true);
  assert.equal(f.players[0].loads,1,'the same format must not be loaded twice');
});

test('rotating preserves the current film and adapts an unplayed film',()=>{
  const f=fixture(true), [morning,dinner]=f.players;
  morning.paused=false;morning.currentTime=12;
  f.resize(false);
  assert.equal(morning.src,'/morning-portrait.mp4');
  assert.equal(morning.currentTime,12);
  assert.equal(morning.loads,1);
  assert.equal(dinner.src,'/dinner.mp4');
  assert.equal(dinner.poster,'/dinner.jpg');
  morning.paused=true;f.resize(false);
  assert.equal(morning.loads,1,'pausing must not discard the visitor’s position');
});

test('playing a film stops other audio and backgrounding pauses playback',()=>{
  const f=fixture(), [morning,dinner]=f.players;
  morning.paused=false;dinner.paused=false;
  dinner.events.get('play')();
  assert.equal(morning.paused,true);
  assert.equal(dinner.paused,false);
  f.hide();
  assert.equal(dinner.paused,true);
});
