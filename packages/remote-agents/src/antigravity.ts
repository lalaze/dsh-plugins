import type { Model, Task } from './domain.js';

export const ANTIGRAVITY_NOTICE = 'Antigravity headless mode denies operations that require interactive approval. Configure permissions in agy before running tasks.';

export function decodeAntigravityModels(output: string): Model[] {
  const models = new Map<string, Model>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z0-9][a-z0-9._/-]*)\t+(.+?)\s*$/i);
    if (match) models.set(match[1], { id: match[1], label: match[2] });
  }
  return [...models.values()];
}

export function antigravityArguments(command: string, task: Task, resume: boolean): string[] {
  return [command, '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', task.model,
    ...(task.modeId && task.modeId !== 'default' ? ['--mode', task.modeId] : []),
    ...(resume ? ['--conversation', task.native!.sessionId] : [])];
}

/** Runs on the SSH host. Owns only its child CLI and forwards native JSONL unchanged. */
export const ANTIGRAVITY_RUNNER = String.raw`
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let timer, ended = false, interrupted = false;
function interrupt() {
  if (ended || interrupted) return;
  interrupted = true;
  child.kill('SIGINT');
  timer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
}
input.on('line', line => {
  try {
    if (JSON.parse(line).event === 'dsh_interrupt') { interrupt(); return; }
    if (!ended) child.stdin.write(line + '\n');
  } catch (error) { console.error(String(error)); interrupt(); }
});
process.stdin.on('end', interrupt);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
child.stdin.on('error', () => {});
child.on('error', error => { console.error(error.message); process.exitCode = 1; input.close(); process.stdin.destroy(); });
child.on('close', code => { ended = true; clearTimeout(timer); input.close(); process.stdin.destroy(); process.exitCode = code ?? 1; });
`;
