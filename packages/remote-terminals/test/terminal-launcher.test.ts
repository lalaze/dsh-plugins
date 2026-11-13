import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
// The saved machines and a remote workspace's folder are Remote Agents', as they are in DSH.
import { fixture } from '../../remote-agents/test/fakes.js';
import { ensureAnchor } from '../../remote-agents/src/workspace/remote-workspaces.js';
import { installWorkspaceTerminal } from '../src/terminal.js';

test('native terminal launcher resolves the workspace, refuses an invalid binding and opens the local shell elsewhere', async t => {
  if (process.platform === 'win32') { t.skip('POSIX terminal launcher test'); return; }
  const f = await fixture(t);
  // macOS process.cwd() canonicalizes /var to /private/var; keep containment inputs identical.
  const directory = await realpath(f.directory), modules = join(directory, 'modules'), bin = join(directory, 'bin'), capture = join(directory, 'ssh-args.json');
  const shell = join(bin, 'local-shell'), omc = join(directory, 'omc');
  await mkdir(modules); await mkdir(bin); await writeFile(join(modules, 'package.json'), '{"type":"module"}');
  // Every launcher invocation has a finite fallback, never the developer's interactive shell.
  await writeFile(shell, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.DSH_TERMINAL_CAPTURE,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electron:process.env.ELECTRON_RUN_AS_NODE??null}));\n`); await chmod(shell, 0o700);
  for (const name of ['core/domain', 'core/saved-hosts', 'core/ssh', 'core/remote-host', 'core/access', 'tui', 'tui-state', 'holder-protocol', 'terminal-hold']) {
    // As the build lays them out: the shared core's files beside the plugin's own in core/, imported by relative path.
    const source = await readFile(new URL(name.startsWith('core/') ? `../../remote-core/src/${name.slice(5)}.ts` : `../src/${name}.ts`, import.meta.url), 'utf8');
    await mkdir(dirname(join(modules, name)), { recursive: true });
    const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' });
    await writeFile(join(modules, `${name}.js`), code.replace(/(["'])@dsh-plugins\/remote-core\//g, name.startsWith('core/') ? '$1./' : '$1./core/'));
  }
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-G'))process.stdout.write('hostname build-box\\nuser builder\\nport 22\\n');else fs.writeFileSync(process.env.DSH_TERMINAL_CAPTURE,JSON.stringify(process.argv.slice(2)));\n`); await chmod(join(bin, 'ssh'), 0o700);
  const anchor = await ensureAnchor(directory, { host: 'build-box', username: 'builder', port: 22 }, '/srv/app');
  const controller = { config: { shellCandidates: ['/bin/sh'] } };
  const { shell: launcher, dispose: cleanup } = await installWorkspaceTerminal(controller, join(directory, 'terminal'), { hosts: f.path, tui: f.path }, pathToFileURL(modules + '/')); t.after(cleanup);
  assert.ok(launcher); assert.equal(controller.config.shellCandidates[1], launcher);
  const env = { ...process.env, HOME: directory, SHELL: shell, DSH_HOME: directory, DSH_OMC_STATE_DIR: omc, DSH_TERMINAL_CAPTURE: capture, PATH: `${bin}:${process.env.PATH}` };
  const launch = (cwd: string) => promisify(execFile)(launcher, [], { cwd, env, timeout: 5000 });
  await launch(anchor);
  const args: string[] = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(args.includes('-tt')); assert.ok(args.includes('builder@build-box')); assert.equal(args.at(-1), 'cd \'/srv/app\' && exec "${SHELL:-/bin/sh}" -l');
  // Remote Claude starts Claude Code in the same place and leaves a shell behind when it exits.
  const claude = controller.config.shellCandidates[2]!; assert.equal(basename(claude), 'Remote Claude');
  const launchClaude = (cwd: string) => promisify(execFile)(claude, [], { cwd, env, timeout: 5000 });
  await launchClaude(anchor);
  assert.equal(JSON.parse(await readFile(capture, 'utf8')).at(-1), 'cd \'/srv/app\' && export COLORTERM=truecolor CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 && exec "${SHELL:-/bin/sh}" -lic \'claude; exec "${SHELL:-/bin/sh}" -l\'');
  // With local scrolling switched off Claude Code keeps its fullscreen renderer.
  const beforeScroll = await readFile(f.path, 'utf8');
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(beforeScroll), tuiLocalScroll: false }));
  await launchClaude(anchor);
  assert.equal(JSON.parse(await readFile(capture, 'utf8')).at(-1), 'cd \'/srv/app\' && export COLORTERM=truecolor && exec "${SHELL:-/bin/sh}" -lic \'claude; exec "${SHELL:-/bin/sh}" -l\'');
  await writeFile(f.path, beforeScroll);
  // In a TUI conversation it is the same Claude session every time, resumed once Claude Code has saved it.
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  await writeFile(f.path, JSON.stringify({ ...state, tuiSessions: ['session-tui', 'session-opus'], tuiDetails: { 'session-opus': { model: 'opus[1m]', effort: 'high', title: 'Claude Code' } } }));
  const launchTui = async (session: string) => { await promisify(execFile)(claude, [], { cwd: anchor, env: { ...env, DSH_SESSION_ID: session }, timeout: 5000 }); return JSON.parse(await readFile(capture, 'utf8')).at(-1) as string; };
  const tui = await launchTui('session-tui'), id = /--resume ([0-9a-f-]{36});/.exec(tui)?.[1];
  assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(tui, `cd '/srv/app' && export COLORTERM=truecolor CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 && exec "\${SHELL:-/bin/sh}" -lic 'if find "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name ${id}.jsonl 2>/dev/null | grep -q .; then claude --resume ${id}; else claude --session-id ${id}; fi; exec "\${SHELL:-/bin/sh}" -l'`);
  assert.equal(await launchTui('session-tui'), tui, 'stable across launches');
  // Remote Codex does the same with the thread saved when the conversation started.
  const codex = controller.config.shellCandidates[3]!; assert.equal(basename(codex), 'Remote Codex');
  const thread = '01a1a960-0696-7481-b86c-ea7a878c6479';
  const launchCodex = async (session?: string) => { await promisify(execFile)(codex, [], { cwd: anchor, env: { ...env, ...(session ? { DSH_SESSION_ID: session } : {}) }, timeout: 5000 }); return JSON.parse(await readFile(capture, 'utf8')).at(-1) as string; };
  const plainCodex = `cd '/srv/app' && export COLORTERM=truecolor && exec "\${SHELL:-/bin/sh}" -lic 'codex --no-alt-screen -c check_for_update_on_startup=false; exec "\${SHELL:-/bin/sh}" -l'`;
  assert.equal(await launchCodex(), plainCodex, 'outside a TUI conversation it is plain Codex');
  assert.equal(await launchCodex('session-chat'), plainCodex);
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(await readFile(f.path, 'utf8')), tuiSessions: ['session-tui', 'session-opus', 'session-codex', 'session-bare'], tuiDetails: { 'session-opus': { model: 'opus[1m]', effort: 'high', title: 'Claude Code' }, 'session-codex': { cli: 'codex', thread, model: 'gpt-6.1-sol', effort: 'xhigh', title: 'Codex' }, 'session-bare': { cli: 'codex', thread, title: 'Codex' } } }));
  assert.equal(await launchCodex('session-codex'), `cd '/srv/app' && export COLORTERM=truecolor && exec "\${SHELL:-/bin/sh}" -lic 'dsh_file=$(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -maxdepth 4 -name "rollout-*-${thread}.jsonl" 2>/dev/null | head -n 1); if [ -z "$dsh_file" ]; then codex --no-alt-screen -c check_for_update_on_startup=false -m "gpt-6.1-sol" -c model_reasoning_effort="xhigh"; elif grep -q task_started "$dsh_file"; then codex resume --no-alt-screen -c check_for_update_on_startup=false ${thread}; else codex resume --no-alt-screen -c check_for_update_on_startup=false -m "gpt-6.1-sol" -c model_reasoning_effort="xhigh" ${thread}; fi; exec "\${SHELL:-/bin/sh}" -l'`, 'the model applies until the thread has a turn');
  assert.ok((await launchCodex('session-bare')).includes(`else codex resume --no-alt-screen -c check_for_update_on_startup=false ${thread}; fi`), 'with no model chosen Codex uses its own');
  assert.equal(await launchCodex('session-tui'), plainCodex, 'in a Claude conversation Remote Codex is plain Codex');
  assert.equal(await launchTui('session-codex'), `cd '/srv/app' && export COLORTERM=truecolor CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 && exec "\${SHELL:-/bin/sh}" -lic 'claude; exec "\${SHELL:-/bin/sh}" -l'`, 'and in a Codex conversation Remote Claude is plain Claude');
  assert.doesNotMatch(await launchTui('session-chat'), /--resume/, 'another conversation runs a plain claude');
  // The composer's model applies to the first launch; a resumed session keeps what /model chose since.
  const opus = await launchTui('session-opus'), opusId = /--resume ([0-9a-f-]{36});/.exec(opus)?.[1];
  assert.ok(opus.includes(`then claude --resume ${opusId}; else claude --session-id ${opusId} --model "opus[1m]" --effort "high"; fi`), opus);
  // A conversation another DSH started runs the Claude session it has there, whatever this DSH calls its conversation.
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(await readFile(f.path, 'utf8')), tuiSessions: ['session-tui', 'session-here'], tuiDetails: { 'session-here': { key: 'session-tui' } } }));
  assert.equal(await launchTui('session-here'), tui, 'the same session as in the DSH that started it');
  await launch(anchor);
  await writeFile(join(anchor, '.dsh-remote-meta.json'), '{}');
  await assert.rejects(launch(anchor), /valid remote workspace binding/);
  const placeholder = join(omc, 'remote-workspaces', 'removed'); await mkdir(placeholder, { recursive: true });
  await assert.rejects(launch(placeholder), /verified remote workspace/);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), args, 'invalid bindings and unverified OMC placeholders launch neither SSH nor the fallback shell');
  // The DSH-wide remembered shell also opens local conversations, which get the local shell instead of SSH.
  const local = join(directory, 'project'); await mkdir(local);
  const { stderr } = await launch(local);
  assert.match(stderr, /Not a remote workspace/);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args: ['-i'], cwd: local, electron: null });
  assert.match((await launchClaude(local)).stderr, /Not a remote workspace/, 'Remote Claude never starts Claude on the DSH machine');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args: ['-i'], cwd: local, electron: null });
  assert.match((await promisify(execFile)(codex, [], { cwd: local, env, timeout: 5000 })).stderr, /Not a remote workspace/, 'nor Remote Codex Codex');
  cleanup(); assert.deepEqual(controller.config.shellCandidates, ['/bin/sh']);
});
