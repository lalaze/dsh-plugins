import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { NATIVE_SCRIPT } from '../../src/chat/native-registry.js';

export async function registryFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-registry-autonomy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'registry.mjs'), directory = join(root, 'authority'); await writeFile(script, NATIVE_SCRIPT);
  const run = (request: Record<string, unknown>): Promise<any> => new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.stdin.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') reject(e); });
    child.on('error', reject); child.on('exit', code => {
      if (code) return reject(Error(error));
      try { const result = JSON.parse(output); result.error ? reject(Error(result.error)) : accept(result.result); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(request));
  });
  const call = (action: string, data: Record<string, unknown> = {}) => run({ protocol: 'shared-native-v1', instance: 'instance-air', action, ...data });
  return { root, directory, run, call };
}
