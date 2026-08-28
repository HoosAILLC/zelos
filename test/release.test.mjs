/**
 * test/release.test.mjs — the promises a release build leans on.
 *
 * Cutting a release spans files nothing at runtime ever compares. The checks
 * here are cheap and textual, and each exists because the seam it pins could
 * otherwise only go red at the far end of a 40-minute two-OS CI build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the root and desktop manifests carry the same version', () => {
  /* The release pipeline reads both, and never side by side: the staging
     script derives the artifact names it expects from the root package.json,
     while electron-builder stamps `${version}` from desktop/package.json into
     the names it actually writes. Both fields are edited by hand, so a
     one-sided bump builds installers named for the old version — and the
     mismatch surfaces only after both runners have finished. This is the one
     place the two fields meet before any CI minutes are spent. */
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  assert.equal(desktop.version, root.version,
    'package.json and desktop/package.json disagree on the version — a release bump edits both');
});

test('CI installs the shell\'s build tools from the lockfile, with no fallback', () => {
  /* desktop/.gitignore keeps package-lock.json tracked on purpose: an app
     that asks people to trust an unsigned build should pin exactly what went
     into it. `npm ci` is that pin's enforcement, and `npm ci || npm install`
     undoes it in precisely the case npm ci exists to catch — a lockfile that
     no longer satisfies package.json — by resolving whatever is newest that
     day and building green, with the workflow log as the only trace. A stale
     lockfile must fail the build loudly; the fix is a one-commit regen. */
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.match(workflow, /^\s*run: npm ci\s*$/m,
    'the workflow no longer installs the shell\'s build tools with npm ci alone');
  assert.doesNotMatch(workflow, /npm ci\s*\|\|/,
    'a fallback after npm ci ships whatever resolves that day instead of what the lockfile pinned');
});
