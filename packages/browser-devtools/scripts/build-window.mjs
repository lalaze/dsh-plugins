import { build } from 'esbuild';
await build({ entryPoints: ['src/client/window.ts'], outfile: 'lib/window.js', bundle: true, format: 'iife', platform: 'browser', minify: true });
