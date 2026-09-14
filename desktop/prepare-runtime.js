/** Stage only the locked production packages beside the packaged core. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sortedEntries = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));

export function prepareRuntimeDependencies({root = path.resolve(HERE, '..')} = {}) {
  const manifest = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  if (!lock.packages || lock.version !== manifest.version || sortedEntries(lock.packages['']?.dependencies) !== sortedEntries(manifest.dependencies)) {
    throw new Error('The runtime package manifest and lockfile disagree. Run npm ci from the repository root.');
  }
  const packages = [];
  for (const [name, info] of Object.entries(lock.packages)) {
    if (!name || info.dev === true) continue;
    if (!name.startsWith('node_modules/') || name.includes('\\') || path.posix.normalize(name) !== name || name.split('/').some(part => part === '..' || part === '.')) {
      throw new Error(`Invalid runtime dependency path: ${name}`);
    }
    const source = path.join(root, name);
    if (!fs.existsSync(source) && info.optional === true) continue;
    if (!fs.existsSync(source)) throw new Error(`Missing runtime dependency ${name}. Run npm ci from the repository root.`);
    if (info.link || fs.lstatSync(source).isSymbolicLink()) throw new Error(`Runtime dependency must be installed from the lockfile: ${name}`);
    const installed = readJson(path.join(source, 'package.json'));
    if (!info.version || installed.version !== info.version) throw new Error(`Runtime dependency version does not match the lockfile: ${name}`);
    packages.push({name, source});
  }
  for (const name of Object.keys(manifest.dependencies || {})) {
    if (!packages.some(pkg => pkg.name === 'node_modules/' + name)) throw new Error(`Missing declared runtime dependency: ${name}`);
  }
  const destination = path.join(root, 'desktop', '.runtime-node-modules');
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Runtime staging directory cannot be a symbolic link.');
  fs.rmSync(destination, {recursive: true, force: true});
  fs.mkdirSync(destination, {recursive: true});
  for (const {name, source} of packages) {
    const target = path.join(destination, name.slice('node_modules/'.length));
    // Nested dependencies are copied from their own lock entries. Copying a
    // package's entire node_modules would accidentally include development tools.
    fs.cpSync(source, target, {recursive: true, filter: file => path.relative(source, file).split(path.sep)[0] !== 'node_modules'});
  }
  return {directory: destination, packages: packages.map(pkg => pkg.name)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareRuntimeDependencies();
  console.log(`Staged ${result.packages.length} locked production packages for the desktop app.`);
}
