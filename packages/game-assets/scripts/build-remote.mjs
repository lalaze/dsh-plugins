// Bundles src/remote-agent.ts into one script that a remote machine's Node.js runs from standard input.
import { stat } from 'node:fs/promises';
import { build } from 'esbuild';

export const remoteBundle = { entryPoints: ['src/remote-agent.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true, legalComments: 'none' };
if (process.argv[1] === new URL(import.meta.url).pathname) {
  await build({ ...remoteBundle, absWorkingDir: process.cwd(), outfile: 'lib/remote-agent.cjs' });
  // The script travels as one shell argument, which Linux limits to 128 KiB; a request and quoting come on top.
  const { size } = await stat('lib/remote-agent.cjs');
  if (size > 80 * 1024) throw new Error(`lib/remote-agent.cjs is ${size} bytes; over 80 KiB it may no longer fit a remote command.`);
}
