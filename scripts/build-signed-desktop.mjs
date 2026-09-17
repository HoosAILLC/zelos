import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { signingConfig } from './signing-config.mjs';
import { prepareRuntimeDependencies } from '../desktop/prepare-runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const arch = process.argv[2];
if (!['arm64', 'x64'].includes(arch)) throw new Error('Choose exactly one installer architecture: arm64 or x64');
const config = signingConfig(process.env, process.platform, arch);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const desktop = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
if (manifest.version !== desktop.version) throw new Error('App and desktop versions must match');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) throw new Error('Release tag and app version must match');
if (process.platform === 'darwin' && process.arch !== arch) throw new Error('Mac releases must be built and tested on their native architecture');
if (process.platform === 'win32' && process.arch !== 'x64') throw new Error('Windows signing requires an x64 runner; ARM64 is tested on a separate native runner');
if (process.argv.includes('--check')) {
  console.log('Signing prerequisites are present; identity validity is checked during signing.');
} else {
  prepareRuntimeDependencies({ root });
  const require = createRequire(path.join(root, 'desktop/package.json'));
  const { build, Platform, Arch } = require('electron-builder');
  await build({ projectDir: path.join(root, 'desktop'), config, publish: 'never',
    targets: (process.platform === 'darwin' ? Platform.MAC : Platform.WINDOWS)
      .createTarget(process.platform === 'darwin' ? ['dmg', 'zip'] : 'nsis', Arch[arch]),
  });
}
