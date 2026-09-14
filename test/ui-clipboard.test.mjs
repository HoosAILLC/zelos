import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/ui-dom.mjs';
import { copyText } from '../ui/lib/dom.js';

test('clipboard fallback restores editor focus and selection when native clipboard is denied',async t=>{
  const document=installDom(t),original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw new Error('NotAllowedError');}}}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
  const create=document.createElement;document.createElement=tag=>{const node=create(tag);if(tag==='textarea')node.select=()=>{node.focus();};return node;};
  const editor=document.body.appendChild(document.createElement('textarea'));editor.value='Keep my current draft';editor.selectionStart=5;editor.selectionEnd=7;editor.selectionDirection='backward';
  editor.setSelectionRange=(start,end,direction)=>{editor.selectionStart=start;editor.selectionEnd=end;editor.selectionDirection=direction;};editor.focus();
  let copied;document.execCommand=command=>{assert.equal(command,'copy');copied=document.activeElement.value;return true;};
  assert.equal(await copyText('The answer to copy'),true);assert.equal(copied,'The answer to copy');
  assert.ok(document.activeElement===editor);assert.equal(editor.value,'Keep my current draft');
  assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[5,7,'backward']);
  assert.equal(document.body.querySelectorAll('textarea').length,1);
});

test('clipboard fallback failure returns false and cleans up without losing keyboard focus',async t=>{
  const document=installDom(t),original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
  const create=document.createElement;document.createElement=tag=>{const node=create(tag);if(tag==='textarea')node.select=()=>{node.focus();throw new Error('Selection unavailable');};return node;};
  const trigger=document.body.appendChild(document.createElement('button'));trigger.focus();
  assert.equal(await copyText('Some text'),false);assert.ok(document.activeElement===trigger);assert.equal(document.body.querySelectorAll('textarea').length,0);
});
