// The terminal holder runs on SSH hosts, so everything it needs goes into one file.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/terminal-holder.ts'], outfile: 'lib/terminal-holder.mjs', bundle: true, format: 'esm', platform: 'node',
  target: 'node22', minify: true, legalComments: 'none', logLevel: 'error',
  // A CommonJS file in the bundle may ask for Node's own modules.
  banner: { js: 'import{createRequire as __dshRequire}from"node:module";const require=__dshRequire(import.meta.url);' },
});
