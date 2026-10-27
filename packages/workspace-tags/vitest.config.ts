import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { clientBundles } from './test/fixtures/client-bundles.ts'

const fixture = (path: string) => fileURLToPath(new URL(`./test/fixtures/${path}`, import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }

// Upstream's suites run against DSH sources; these run against the published
// rc.3 packages instead. The suites left out need DSH sources or runtime
// wiring (LocaleRuntime, ShortcutRegistry, the stock ui-workspace client)
// beyond the few unpublished files vendored under test/fixtures.
const upstreamSuites = ['tree', 'animated-rows', 'browser-styles', 'rows', 'workspace-browser', 'workspace-picker']

export default defineConfig({
  plugins: [clientBundles()],
  resolve: {
    alias: {
      // Unpublished DSH sources the specs and dsh-client-test-runtime import, vendored at the same commit.
      '@deepseek-ai/dsh-client-locale/src/locales/en.ts': fixture('dsh-client-locale/en.ts'),
      '@deepseek-ai/dsh-client-locale/src/locales/zh.ts': fixture('dsh-client-locale/zh.ts'),
      '@deepseek-ai/dsh-client-ui-renderer/src/client': fixture('upstream-src/client/ui-renderer/src/client'),
      '@deepseek-ai/dsh-api-session-controller/src/client': fixture('upstream-src/api/session-controller/src/client'),
    },
    // Published DSH packages omit their DSH dependencies; resolve every one to
    // this package's rc.3 copy rather than the repo's hoisted rc.2 copies.
    dedupe: ['react', 'react-dom', ...Object.keys(manifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/'))],
  },
  test: {
    include: [
      ...upstreamSuites.map(name => `test/upstream/${name}.client.spec.{ts,tsx}`),
      'test/client/**/*.spec.{ts,tsx}',
    ],
    setupFiles: ['./test/setup-dom.ts'],
    // Through Vite, so the aliases and the client-bundle rewrite apply inside DSH packages too.
    server: { deps: { inline: [/@deepseek-ai\//] } },
  },
})
