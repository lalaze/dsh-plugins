import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport, quote } from '../src/core/ssh.js';

async function fixture(t: TestContext, shell: 'bash' | 'zsh', options: { closeDescriptors?: boolean; startup?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shell-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile'), executable = join(root, shell), ssh = join(root, 'ssh');
  const temporary = join(root, "temporary ' login exports"); await mkdir(temporary);
  // Deliberately try to read stdin and emit a JSON-looking banner before the CLI starts.
  const startup = `${options.closeDescriptors ? 'exec 3<&- 4>&-\n' : ''}export DSH_TEST_REMOTE_AUTH='profile-loaded'
printf '{"startup":"must not enter the protocol"}\\n'
IFS= read -r dsh_startup_input || true
export DSH_TEST_STARTUP_INPUT="$dsh_startup_input"
${options.startup ?? ''}
`;
  if (shell === 'bash') {
    await writeFile(profile, startup);
    await writeFile(executable, `#!/bin/sh
[ "$1" = '-lic' ] || exit 97
shift
exec /bin/bash --noprofile --rcfile ${quote(profile)} -ic "$@"
`, { mode: 0o755 });
  } else {
    await writeFile(join(root, '.zprofile'), 'export DSH_TEST_LOGIN=loaded\n');
    await writeFile(join(root, '.zshrc'), startup + 'test "$DSH_TEST_LOGIN" = loaded || exit 96\n');
    await writeFile(executable, `#!/bin/sh
export ZDOTDIR=${quote(root)}
exec /bin/zsh "$@"
`, { mode: 0o755 });
  }
  // Exercise OpenSshTransport's real generated command, substituting only SSH's remote process boundary.
  await writeFile(ssh, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], {
  stdio: 'inherit', env: { ...process.env, SHELL: ${JSON.stringify(executable)}, TMPDIR: ${JSON.stringify(temporary)} }
});
child.on('error', () => process.exit(98));
child.on('exit', code => process.exit(code ?? 99));
`, { mode: 0o755 });
  return { root, temporary, transport: new OpenSshTransport('ssh://fixture.invalid', ssh) };
}

for (const shell of ['bash', 'zsh'] as const) {
  test(`${shell}: SSH probes receive the interactive login environment without startup output`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const { transport } = await fixture(t, shell);
    assert.equal(await transport.exec('printf "%s" "${DSH_TEST_REMOTE_AUTH:-missing}"'), 'profile-loaded');
    await assert.rejects(transport.exec('printf "payload-failed" >&2; exit 7'), /payload-failed/);
  });

  test(`${shell}: native CLI startup preserves stdin, quoting and working directory`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const { root, transport } = await fixture(t, shell);
    const cwd = join(root, "project ' with spaces"); await mkdir(cwd);
    const argument = 'literal $HOME `ignored` "double" \'single\'';
    const program = `process.stdin.once('data', data => {
      process.stdout.write(JSON.stringify({ auth: process.env.DSH_TEST_REMOTE_AUTH, startupInput: process.env.DSH_TEST_STARTUP_INPUT,
        input: data.toString(), cwd: process.cwd(), argument: process.argv[1] }) + '\\n');
      process.exit(0);
    });`;
    const child = transport.start(cwd, [process.execPath, '-e', program, argument]);
    t.after(() => child.stop());
    const output = new Promise<string>((resolve, reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error('Native CLI did not receive its input')), 10_000);
      child.onData(data => { received += data.toString(); });
      child.onExit(() => { clearTimeout(timer); resolve(received); });
    });
    const message = '{"type":"user","message":"hello"}\n';
    child.write(message);
    assert.deepEqual(JSON.parse(await output), { auth: 'profile-loaded', startupInput: '', input: message,
      cwd: await realpath(cwd), argument });
  });

  test(`${shell}: SSH probes survive startup scripts closing inherited descriptors`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const { transport } = await fixture(t, shell, { closeDescriptors: true });
    assert.equal(await transport.exec('printf "%s" "${DSH_TEST_REMOTE_AUTH:-missing}"'), 'profile-loaded');
  });

  test(`${shell}: CLI input survives startup scripts closing inherited descriptors`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const { root, temporary, transport } = await fixture(t, shell, { closeDescriptors: true });
    const child = transport.start(root, [process.execPath, '-e', 'process.stdin.pipe(process.stdout)']);
    t.after(() => child.stop());
    const message = '{"type":"user","message":"hello after login"}\n';
    const output = new Promise<string>((resolve, reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error('Native CLI did not receive its input')), 5000);
      child.onData(data => { received += data.toString(); if (received === message) { clearTimeout(timer); resolve(received); } });
      child.onExit(error => { clearTimeout(timer); reject(error); });
    });
    child.write(message);
    assert.equal(await output, message);
    assert.deepEqual(await readdir(temporary), [], 'temporary exports are gone before the CLI handles a message');
  });

  test(`${shell}: exported environment keeps quotes, newlines and shell syntax literal`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const value = 'literal $HOME $(printf changed) `printf changed` "double" \'single\'\nsecond line 中文';
    const { temporary, transport } = await fixture(t, shell, { startup: `export DSH_TEST_COMPLEX=${quote(value)}` });
    assert.equal(await transport.exec('printf "%s" "$DSH_TEST_COMPLEX"'), value);
    assert.deepEqual(await readdir(temporary), []);
  });

  test(`${shell}: failed or interrupted login initialization leaves no saved environment`, async t => {
    try { await access(`/bin/${shell}`); } catch { t.skip('Shell unavailable'); return; }
    const failed = await fixture(t, shell, { startup: 'printf "startup-failed\\n" >&2; exit 23' });
    await assert.rejects(failed.transport.exec('printf should-not-run'), /startup-failed/);
    assert.deepEqual(await readdir(failed.temporary), []);
    const ended = await fixture(t, shell, { startup: 'exit 0' });
    await assert.rejects(ended.transport.exec('printf should-not-run'), /Remote login shell did not export its environment/);
    assert.deepEqual(await readdir(ended.temporary), []);
  });
}
