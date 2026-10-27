/**
 * Vite plugin: published DSH `lib/client.js` files are module-loader bundles
 * (`window.__ModuleLoader__.load({ id, factory })`), not ES modules. Rewrite
 * each into an ES module that runs its factory with ESM-imported externals,
 * so the specs can import runtime classes such as `SlotRegistry`.
 */
import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'

const CLIENT_BUNDLE = /\/node_modules\/@deepseek-ai\/[^/]+\/lib\/client\.js$/
const DSH_LIBRARY = /\/node_modules\/@deepseek-ai\/[^/]+\/lib\/.+\.js$/

export function clientBundles(): Plugin {
  return {
    name: 'dsh-client-bundles',
    enforce: 'pre',
    // Published DSH libraries reference source maps they do not ship.
    async load(id) {
      const file = id.split('?', 1)[0]!
      if (!DSH_LIBRARY.test(file)) return
      return (await readFile(file, 'utf8')).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')
    },
    transform(code, id) {
      if (!CLIENT_BUNDLE.test(id.split('?', 1)[0]!) || !code.startsWith('window.__ModuleLoader__.load(')) return
      const requests = [...new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]!))]
      const names = [...new Set([...code.matchAll(/exports\.([A-Za-z_$][\w$]*) =/g)].map(match => match[1]!))]
        .filter(name => name !== 'default')
      return [
        ...requests.map((request, index) => `import * as __external${index} from ${JSON.stringify(request)};`),
        // Mark namespaces as ES modules so the bundle's interop reads `default` as-is.
        `const __externals = new Map([${requests.map((request, index) =>
          `[${JSON.stringify(request)}, { ...__external${index}, __esModule: true }]`).join(', ')}]);`,
        'let __registration;',
        'const __window = globalThis.window ?? (globalThis.window = globalThis);',
        'const __previous = __window.__ModuleLoader__;',
        '__window.__ModuleLoader__ = { load: registration => { __registration = registration } };',
        code,
        '__window.__ModuleLoader__ = __previous;',
        'const __exports = __registration.factory(request => {',
        '  const external = __externals.get(request);',
        '  if (external === undefined) throw new Error(`client bundle requested unknown module ${request}`);',
        '  return external;',
        '});',
        'export default __exports;',
        ...names.map(name => `export const ${name} = __exports.${name};`),
      ].join('\n')
    },
  }
}
