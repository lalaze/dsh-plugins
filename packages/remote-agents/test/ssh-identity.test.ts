import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { SshBackend } from '../src/agents/backend.js';
import { quote, type SshTransport } from '../src/core/ssh.js';
import { Store } from '../src/core/store.js';

const run = promisify(execFile);
const expected = (unique: string) => `ssh-${createHash('sha256').update(JSON.stringify(['test-macmini', 'test-user', unique])).digest('hex')}`;

for (const shell of ['/bin/sh', '/bin/zsh']) {
  for (const scenario of ['empty', 'missing', 'populated'] as const) {
    test(`${shell}: SSH identity handles a ${scenario} machine-id using the actual generated shell command`, async t => {
      try { await access(shell); } catch { t.skip(`${shell} is not available`); return; }
      const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-identity-')), bin = join(directory, 'bin');
      t.after(() => rm(directory, { recursive: true, force: true }));
      await mkdir(bin);
      await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -n) printf test-macmini;; -s) printf Darwin;; *) exit 2;; esac\n', { mode: 0o755 });
      await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf test-user\n', { mode: 0o755 });
      await writeFile(join(bin, 'cat'), `#!/bin/sh\n${scenario === 'missing' ? 'exit 1' : scenario === 'empty' ? 'exit 0' : 'printf linux-machine-id'}\n`, { mode: 0o755 });
      const transport: SshTransport = {
        exec: async script => (await run(shell, [...(shell.endsWith('zsh') ? ['-f'] : []), '-c', `PATH=${quote(bin)}; export PATH; ${script}`], { encoding: 'utf8' })).stdout,
        start: () => { throw new Error('Identity verification must not start a coding CLI'); },
      };
      const backend = new SshBackend({ id: 'identity-test', label: 'Test Mac', connection: 'ssh://macmini' }, new Store(join(directory, 'state.json')), transport);
      t.after(() => backend.close());
      assert.equal(await backend.connect(), expected(scenario === 'populated' ? 'linux-machine-id' : 'Darwin'));
    });
  }
}
