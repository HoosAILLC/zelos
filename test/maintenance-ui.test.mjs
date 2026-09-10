import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';
import { backupPanel } from '../ui/lib/backup.js';

test('native backup controls select no renderer paths, prevent overlap and recover from cancellation/failure', async t => {
  const document = installDom(t);
  assert.equal(backupPanel(), null, 'browser UI cannot request filesystem access');
  let finish; const calls = [];
  window.zelos = { desktop: true,
    createBackup: (...args) => { calls.push(['create', args]); return new Promise(resolve => { finish = resolve; }); },
    restoreBackup: async (...args) => { calls.push(['restore', args]); return { ok: false, error: 'Close the connected AI client first.' }; },
  };
  const panel = backupPanel();
  document.body.appendChild(panel);
  assert.equal(calls.length, 0);
  const create = findButton(panel, 'Create backup'); const restore = findButton(panel, 'Restore a backup…');
  create.click(); restore.click(); create.click();
  assert.deepEqual(calls, [['create', []]]);
  assert.equal(create.disabled, true); assert.equal(restore.disabled, true);
  finish({ ok: false, cancelled: true }); await settle();
  assert.match(text(panel), /Cancelled\. Your data is unchanged/);
  assert.equal(create.disabled, false); assert.equal(restore.disabled, false);
  assert.equal(document.activeElement, create, 'native cancellation returns keyboard focus');
  restore.click(); await settle();
  assert.deepEqual(calls.at(-1), ['restore', []]);
  assert.match(text(panel), /Close the connected AI client first/);
  create.click(); finish({ ok: true }); await settle();
  assert.match(text(panel), /Backup saved/);
  assert.match(text(panel), /not password protected/);
});

test('manual update UI does not fetch on render, renders notes as text and retries after failure', async t => {
  const document = installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const calls = []; let complete;
  globalThis.fetch = (...args) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); const check = findButton(panel, 'Check for updates');
  document.body.appendChild(panel); check.focus();
  assert.equal(calls.length, 0);
  check.click(); check.click(); assert.equal(calls.length, 1);
  document.body.focus(); // Chromium drops focus when the focused button is disabled.
  assert.equal(calls[0][0], '/api/updates/check');
  assert.equal(calls[0][1].method, 'POST'); assert.equal(calls[0][1].body, '{}');
  complete(new Response(JSON.stringify({ error: 'GitHub is temporarily unavailable.' }), { status: 502 })); await settle();
  assert.match(text(panel), /Could not check for updates/);
  assert.doesNotMatch(text(panel), /latest release:/);
  assert.equal(check.disabled, false);
  assert.equal(document.activeElement, check, 'the failed check leaves a keyboard-reachable retry');
  check.click();
  complete(new Response(JSON.stringify({ currentVersion: '1.7.1', latestVersion: '1.8.0', updateAvailable: true,
    releaseUrl: 'https://github.com/HoosAILLC/zelos/releases/tag/v1.8.0', notes: '<img src=x onerror=alert(1)>' })));
  await settle();
  assert.match(text(panel), /1\.8\.0 is available/);
  assert.equal(panel.querySelector('img'), null);
  assert.equal(panel.querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(panel.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(check.disabled, false);
});

test('the update UI rejects an unexpected download destination', async t => {
  installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ currentVersion: '1.7.1', latestVersion: '1.8.0', updateAvailable: true, releaseUrl: 'https://untrusted.example/installer' }));
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); findButton(panel, 'Check for updates').click(); await settle();
  assert.equal(panel.querySelector('a'), null);
  assert.match(text(panel), /release link could not be verified/);
});

test('demo update checks explain their limit without claiming an installed version is current', async t => {
  installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ demo: true }));
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); const check = findButton(panel, 'Check for updates');
  check.click(); await settle();
  assert.match(text(panel), /website demo cannot check an installed copy/);
  assert.doesNotMatch(text(panel), /latest release:/);
  assert.equal(panel.querySelector('a'), null);
  assert.equal(check.disabled, false);
});
