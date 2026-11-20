// The frame browser script (src/frame/entry.ts) as one self-contained classic script, inlined into mounted pages.
import { build } from 'esbuild';

await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['src/frame/entry.ts'],
  outfile: 'lib/frame-browser.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
