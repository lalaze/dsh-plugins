import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { ANTIGRAVITY_RUNNER } from '../src/agents/antigravity.js';
import { JsonlPeer } from '../src/core/ssh.js';

test('the remote Antigravity runner forwards native JSONL and signals its owned child on interrupt', async t => {
  const fake = `
    import { createInterface } from 'node:readline';
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    send({ event: 'init', conversation_id: 'native-test-conversation' });
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      send({ event: 'step_update', step_update: { text_delta: message.message.content } });
    });
    process.on('SIGINT', () => process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'caught SIGINT' } }) + '\\n', () => process.exit(0)));
  `;
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', ANTIGRAVITY_RUNNER, '--', process.execPath, '--input-type=module', '-e', fake], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; processChild.stderr.on('data', data => { stderr += data; });
  processChild.stdin.on('error', () => {});
  const exited = new Promise<number | null>(resolve => processChild.once('close', resolve));
  const peer = new JsonlPeer({
    write: value => { processChild.stdin.write(value); },
    stop: () => { processChild.stdin.end(); processChild.kill('SIGTERM'); },
    onData: callback => { processChild.stdout.on('data', callback); },
    onExit: callback => { processChild.on('error', callback); processChild.on('close', code => callback(new Error(`runner exited ${code}: ${stderr}`))); },
  });
  t.after(async () => { peer.close(); await exited; });
  await peer.waitForMessage(message => message.event === 'init', 3000);
  const update = peer.waitForMessage(message => message.event === 'step_update', 3000);
  peer.send({ event: 'user', message: { content: 'Forward this unchanged' } });
  assert.equal((await update).step_update.text_delta, 'Forward this unchanged');
  const stopped = peer.waitForMessage(message => message.event === 'result', 3000);
  peer.send({ event: 'dsh_interrupt' });
  assert.equal((await stopped).result.error, 'caught SIGINT');
  assert.equal(await exited, 0, stderr);
});
