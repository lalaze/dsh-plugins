// Write THIRD_PARTY_NOTICES.md for the packages a plugin's client bundle includes.
// Run from a plugin directory: node ../../scripts/third-party-notices.mjs "<intro paragraph>" ["<intro paragraph>"...]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const result = await build({
  absWorkingDir: process.cwd(), entryPoints: ['src/client/index.tsx'], bundle: true, format: 'cjs', platform: 'browser', write: false, metafile: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'], logLevel: 'error',
});
const directories = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (match) directories.set(match[2], resolve(match[1]));
}
const packages = [...directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, directory]) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const file = readdirSync(directory).find(entry => /^licen[cs]e/i.test(entry));
  const text = file ? readFileSync(join(directory, file), 'utf8') : '';
  const copyright = text.match(/^\s*copyright.*$/im)?.[0].trim() ?? `Copyright (c) the ${name} authors`;
  return { name, version: manifest.version, license: manifest.license, copyright, text };
});
const unknown = packages.filter(p => p.license !== 'MIT' && p.license !== 'ISC');
if (unknown.length) throw new Error(`Review these licenses by hand: ${unknown.map(p => `${p.name} (${p.license})`).join(', ')}`);

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const ISC = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const section = (license, text) => {
  const listed = packages.filter(p => p.license === license);
  if (!listed.length) return '';
  const rows = listed.map(p => `- \`${p.name}\` ${p.version}: ${p.copyright}`).join('\n');
  return `\n## ${license} License\n\n${rows}\n\n${text}\n`;
};
const intro = process.argv.slice(2).join('\n\n');
writeFileSync('THIRD_PARTY_NOTICES.md', `# Third-party notices\n\n${intro}\n\nThe browser bundle includes the packages below, each under the license of its section; their copyright notices are listed with them. Regenerate this file with \`node ../../scripts/third-party-notices.mjs\`.\n${section('MIT', MIT)}${section('ISC', ISC)}`);
console.log(`THIRD_PARTY_NOTICES.md: ${packages.length} packages in ${dirname(resolve('THIRD_PARTY_NOTICES.md'))}`);
