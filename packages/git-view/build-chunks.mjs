// The Git panel's mermaid renderer, loaded only when a previewed Markdown file has a mermaid block, through the
// ModuleLoader's `require.async('./client.mermaid.js')`, as dsh-git-panel ships it. The licenses of the packages it
// bundles, several of them other than MIT, are written next to it as client.mermaid-notices.txt.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const { name } = JSON.parse(await readFile('package.json', 'utf8'));
const result = await build({
  entryPoints: ['src/gp/client/mermaid-chunk.ts'], outfile: 'lib/client.mermaid.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: true,
  metafile: true, logOverride: { 'commonjs-variable-in-esm': 'silent' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(name)},chunk:"client.mermaid.js",factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
});
const directories = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (match) directories.set(match[2], resolve(match[1]));
}
const sections = [...directories].sort(([a], [b]) => a.localeCompare(b)).map(([pkg, directory]) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const file = readdirSync(directory).find(entry => /^(licen[cs]e|copying)/i.test(entry));
  if (!file) throw new Error(`${pkg} ships no license file; review it by hand`);
  return `${'='.repeat(80)}\n${pkg} ${manifest.version} (${manifest.license ?? 'see below'})\n${'='.repeat(80)}\n\n${readFileSync(join(directory, file), 'utf8').trim()}\n`;
});
await writeFile('lib/client.mermaid-notices.txt', `lib/client.mermaid.js bundles the packages below, each under its own license.\n\n${sections.join('\n')}`);
