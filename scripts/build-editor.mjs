// Build the on-demand code editor bundle a plugin serves: node ../../scripts/build-editor.mjs lib/editor.js
// Monaco and its workers become one ES module; its CSS is injected by the module itself and its icon font inlined.
// Monaco's license and third-party notices, with DOMPurify's license, which Monaco includes but does not list, are
// written next to it as editor-notices.txt.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const fileView = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/file-view');
const outfile = resolve(process.argv[2] ?? 'lib/editor.js');
const monaco = join(fileView, 'node_modules/monaco-editor');
const common = { absWorkingDir: fileView, bundle: true, minify: true, write: false, logLevel: 'error', legalComments: 'eof', target: 'es2022' };

const worker = async entry => (await build({ ...common, entryPoints: [join(monaco, 'esm/vs', entry)], format: 'iife' })).outputFiles[0].text;
const workers = { editor: await worker('editor/editor.worker.js'), json: await worker('language/json/json.worker.js') };
// The Chinese message table assigns a global; the bundle picks it only when the page asks for Chinese.
const zh = (await readFile(join(monaco, 'esm/vs/nls/lang/zh-cn.js'), 'utf8')).match(/globalThis\._VSCODE_NLS_MESSAGES=(\[[\s\S]*?\]);\s*globalThis\._VSCODE_NLS_LANGUAGE=/)?.[1];
if (!zh) throw new Error('Monaco’s zh-cn messages changed shape');
// Language services left out, and the LSP client nothing here uses.
const omitted = /[\\/](?:languages[\\/]features[\\/](?:css|html|typescript)[\\/]register|external[\\/]monaco-lsp-client[\\/]out[\\/]index)\.js$/;
const result = await build({
  ...common, entryPoints: [join(fileView, 'src/monaco/entry.ts')], format: 'esm', outdir: dirname(outfile), entryNames: 'editor',
  loader: { '.ttf': 'dataurl' },
  plugins: [{ name: 'dsh-editor', setup(b) {
    b.onResolve({ filter: /^dsh-(?:worker|nls):/ }, args => ({ path: args.path, namespace: 'dsh-editor' }));
    b.onLoad({ filter: /.*/, namespace: 'dsh-editor' }, args => ({
      contents: `export default ${args.path === 'dsh-nls:zh-cn' ? zh : JSON.stringify(workers[args.path.slice('dsh-worker:'.length)])};`, loader: 'js' }));
    b.onLoad({ filter: omitted }, () => ({ contents: 'export {};', loader: 'js' }));
  } }],
});
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text, css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
const inject = `if(typeof document<"u"&&!document.querySelector("style[data-dsh-editor]")){const s=document.createElement("style");s.dataset.dshEditor="";s.textContent=${JSON.stringify(css)};document.head.append(s)}\n`;
await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, inject + js);
const text = file => readFile(file, 'utf8');
const { version } = JSON.parse(await text(join(monaco, 'package.json')));
// Resolved as Monaco's own dependency, from its real directory.
let purify = dirname(createRequire(join(await realpath(monaco), 'package.json')).resolve('dompurify'));
while (!(await readFile(join(purify, 'package.json'), 'utf8').catch(() => '')).includes('"name": "dompurify"')) purify = dirname(purify);
const { version: purifyVersion } = JSON.parse(await text(join(purify, 'package.json')));
await writeFile(join(dirname(outfile), 'editor-notices.txt'), [
  `editor.js is built from monaco-editor ${version} (https://github.com/microsoft/monaco-editor).\n\n${await text(join(monaco, 'LICENSE'))}`,
  await text(join(monaco, 'ThirdPartyNotices.txt')),
  `%% DOMPurify ${purifyVersion} (https://github.com/cure53/DOMPurify), included by monaco-editor. Copyright (c) Cure53 and other contributors.\nDOMPurify is available under the Apache License 2.0 or the Mozilla Public License 2.0; it is used here under the Apache License 2.0:\n\n${await text(join(purify, 'LICENSE'))}`,
].join('\n\n'));
console.log(`${outfile}: ${(Buffer.byteLength(inject + js) / 1024 / 1024).toFixed(2)} MB (editor worker ${(workers.editor.length / 1024).toFixed(0)} KB, JSON worker ${(workers.json.length / 1024).toFixed(0)} KB, CSS ${(css.length / 1024).toFixed(0)} KB)`);
