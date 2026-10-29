import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_PATH, quote } from '../src/core/ssh.js';

const run = promisify(execFile);
for (const shell of ['/bin/sh', '/bin/zsh']) {
  for (const scenario of ['old-node', 'modern-node', 'no-nvm'] as const) {
    test(`${shell}: SSH runtime selection handles ${scenario}`, async t => {
      try { await access(shell); } catch { t.skip('Shell unavailable'); return; }
      const root = await mkdtemp(join(tmpdir(), 'dsh-node-path-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const node = async (bin: string, version: string) => {
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'node'), `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 });
      };
      const original = join(root, 'original');
      await node(original, scenario === 'modern-node' ? 'v24.1.0' : 'v18.20.4');
      if (scenario !== 'no-nvm') for (const version of ['v18.20.4', 'v22.9.0', 'v22.23.2']) await node(join(root, '.nvm/versions/node', version, 'bin'), version);
      // Exercise the production shell bootstrap with fixture filesystem roots, without changing HOME.
      const script = REMOTE_PATH.replaceAll('$HOME', '$DSH_NODE_TEST_ROOT').replaceAll('/opt/homebrew', `${root}/homebrew`).replaceAll('/usr/local', `${root}/usr-local`);
      const result = await run(shell, [...(shell.endsWith('zsh') ? ['-f'] : []), '-c', `sh -c ${quote(script + 'command -v node; node --version')}`],
        { env: { ...process.env, DSH_NODE_TEST_ROOT: root, NVM_DIR: join(root, '.nvm'), PATH: `${original}:/usr/bin:/bin` }, timeout: 10000 });
      const [path, version] = result.stdout.trim().split('\n');
      assert.equal(version, scenario === 'modern-node' ? 'v24.1.0' : scenario === 'old-node' ? 'v22.23.2' : 'v18.20.4');
      assert.equal(path, join(scenario === 'old-node' ? join(root, '.nvm/versions/node/v22.23.2/bin') : original, 'node'));
    });
  }
}
