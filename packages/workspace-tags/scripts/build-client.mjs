/**
 * Client build for the vendored ui-workspace. Unlike ../../scripts/build-client.mjs
 * it compiles CSS Modules (injected as one style tag when the factory runs, as
 * DSH's own client bundles do) and does not treat every @deepseek-ai/* import
 * as external: only DSH's platform modules are shared at runtime, pure helpers
 * are bundled, and anything else fails the build instead of loading a copy.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const packageDir = process.cwd()
const { name } = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'))

// DSH 0.2.1-rc.3 packages/client/web/src/platform.ts (PLATFORM_MODULES).
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
// DSH 0.2.1-rc.3 packages/client/tsdown.client.ts (INLINE_SAFE): browser-safe values with no shared identity.
const INLINE_SAFE = /^@deepseek-ai\/dsh-(?:util-values|util-workspace-path)(?:\/|$)|^@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$/

const modules = {
  name: 'dsh-modules',
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => {
      if (PLATFORM_MODULES.has(args.path)) return { path: args.path, external: true }
      if (!args.path.startsWith('@deepseek-ai/') || INLINE_SAFE.test(args.path)) return undefined
      return { errors: [{ text: `${args.path} is neither a DSH platform module nor safe to bundle (imported by ${args.importer})` }] }
    })
  },
}

// esbuild names a CSS Module class `<file>_<class>`; a prefixed virtual file name scopes them to this plugin.
const CSS_PREFIX = 'wstags_'
const cssModules = {
  name: 'css-module-prefix',
  setup(builder) {
    builder.onResolve({ filter: /\.module\.css$/ }, args => ({
      path: resolve(dirname(resolve(args.resolveDir, args.path)), CSS_PREFIX + basename(args.path)),
      namespace: 'css-module',
      pluginData: resolve(args.resolveDir, args.path),
    }))
    builder.onLoad({ filter: /.*/, namespace: 'css-module' }, async args => ({
      contents: await readFile(args.pluginData, 'utf8'),
      loader: 'local-css',
      resolveDir: dirname(args.pluginData),
      watchFiles: [args.pluginData],
    }))
  },
}

const result = await build({
  absWorkingDir: packageDir,
  entryPoints: ['src/client/index.ts'],
  outdir: 'lib/.client-build',
  entryNames: 'client',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Identifiers stay unminified: minified CSS Module names (`.a`, `.b`) would collide with other sheets.
  minifyWhitespace: true,
  minifySyntax: true,
  write: false,
  jsx: 'automatic',
  plugins: [modules, cssModules],
  logLevel: 'warning',
})
const output = ext => result.outputFiles.find(file => file.path.endsWith(ext))?.text ?? ''
const css = output('.css')
const tagId = `${name}/client.css`
// The module loader claims style tags a factory adds and removes them when the plugin unloads.
const styles = css === '' ? '' : [
  `var css=${JSON.stringify(css)};`,
  `var tag=document.querySelector('style[data-plugin-css=${JSON.stringify(JSON.stringify(tagId)).slice(1, -1)}]');`,
  `if(tag===null){tag=document.createElement('style');tag.dataset.plugin=${JSON.stringify(name)};tag.dataset.pluginCss=${JSON.stringify(tagId)};document.head.appendChild(tag)}`,
  'tag.textContent=css;',
].join('')
await mkdir(resolve(packageDir, 'lib'), { recursive: true })
await writeFile(resolve(packageDir, 'lib/client.js'), [
  `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
  `if(typeof document!=='undefined'){${styles}}`,
  output('.js'),
  'return module.exports;}});',
].join('\n'))
