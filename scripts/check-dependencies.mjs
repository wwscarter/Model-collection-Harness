import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const suggestions = {};
const issues = [];

if (!lock.packages?.['']) issues.push('package-lock.json must include the root package metadata');
for (const section of sections) {
  const direct = manifest[section] ?? {};
  const lockedRoot = lock.packages?.['']?.[section] ?? {};
  const versions = {};
  for (const [name, requested] of Object.entries(direct)) {
    const installed = lock.packages?.['node_modules/' + name]?.version;
    if (typeof installed === 'string' && exactVersion.test(installed)) versions[name] = installed;
    else issues.push(section + '.' + name + ': no exact resolved version in package-lock.json');
    if (typeof requested !== 'string' || !exactVersion.test(requested)) issues.push(section + '.' + name + ': use an exact version (locked: ' + (installed ?? 'missing') + ')');
    else if (requested !== installed) issues.push(section + '.' + name + ': package.json ' + requested + ' differs from resolved ' + installed);
    if (requested !== lockedRoot[name]) issues.push(section + '.' + name + ': root lockfile declaration differs from package.json');
  }
  for (const name of Object.keys(lockedRoot)) if (!(name in direct)) issues.push(section + '.' + name + ': only present in root lockfile metadata');
  if (Object.keys(versions).length) suggestions[section] = versions;
}

if (process.argv.includes('--suggest')) {
  // Read-only input for a deliberate dependency update; this command changes no files.
  process.stdout.write(JSON.stringify(suggestions, null, 2) + '\n');
} else if (issues.length) {
  process.stderr.write('Dependency version checks failed:\n' + issues.map((issue) => '- ' + issue).join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Direct dependencies are pinned and match package-lock.json.\n');
}
