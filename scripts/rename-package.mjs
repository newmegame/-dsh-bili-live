#!/usr/bin/env node
/**
 * Rename the plugin package in the three places that must agree:
 * package.json, client.js (module id), cordis.patch.yml (row name).
 *
 * Usage: node scripts/rename-package.mjs @yourname/dsh-bili-live
 */
import { readFileSync, writeFileSync } from 'node:fs';

const next = process.argv[2];
if (!next || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(next)) {
  console.error('用法: node scripts/rename-package.mjs <包名>');
  console.error('例如: node scripts/rename-package.mjs @yourname/dsh-bili-live');
  process.exit(1);
}

const root = new URL('../', import.meta.url);
const packagePath = new URL('package.json', root);
const clientPath = new URL('client.js', root);
const patchPath = new URL('cordis.patch.yml', root);

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const previous = pkg.name;
pkg.name = next;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const client = readFileSync(clientPath, 'utf8');
if (!client.includes(`id: '${previous}'`)) {
  console.error(`client.js 里找不到 id: '${previous}'，请手动检查。`);
  process.exit(1);
}
writeFileSync(clientPath, client.replace(`id: '${previous}'`, `id: '${next}'`));

const patch = readFileSync(patchPath, 'utf8');
if (!patch.includes(`name: '${previous}'`)) {
  console.error(`cordis.patch.yml 里找不到 name: '${previous}'，请手动检查。`);
  process.exit(1);
}
writeFileSync(patchPath, patch.replace(`name: '${previous}'`, `name: '${next}'`));

console.log(`已改名: ${previous} -> ${next}`);
console.log('接着可以 npm publish --access public');
