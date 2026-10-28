import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface WindowProcess { close(): Promise<void> }
export type LaunchWindow = (url: string, exited: () => void) => Promise<WindowProcess>;

export function browserCandidates(platform = process.platform, env = process.env, home = homedir()): string[] {
  if (platform === 'darwin') return ['/Applications', join(home, 'Applications')].flatMap(root => [
    join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
    join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    join(root, 'Chromium.app/Contents/MacOS/Chromium'),
  ]);
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((v): v is string => Boolean(v)).flatMap(root => [
    join(root, 'Google/Chrome/Application/chrome.exe'), join(root, 'Microsoft/Edge/Application/msedge.exe'),
  ]);
  return (env.PATH ?? '/usr/bin:/usr/local/bin').split(delimiter).filter(Boolean).flatMap(root =>
    ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser'].map(name => join(root, name)));
}

export const launchWindow: LaunchWindow = async (url, exited) => {
  let executable: string | undefined;
  for (const candidate of browserCandidates()) {
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Try the next installed browser. */ }
  }
  if (!executable) throw new Error('Install Chrome or Edge to open a desktop debugger window.');
  const profile = await mkdtemp(join(tmpdir(), 'dsh-debugger-window-'));
  // No shell, no normal browser profile, no remote debugging port.
  const child = spawn(executable, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-background-mode', '--disable-sync', '--window-size=1100,760'], { stdio: 'ignore' });
  let resolveExit!: () => void;
  const ended = new Promise<void>(resolve => { resolveExit = resolve; });
  const cleanup = async () => {
    exited();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    resolveExit();
  };
  child.once('exit', () => { void cleanup(); });
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } catch {
    await rm(profile, { recursive: true, force: true });
    throw new Error('Could not start Chrome or Edge.');
  }
  return { async close() {
    if (child.exitCode !== null || child.signalCode !== null) { await ended; return; }
    child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    timer.unref();
    await ended;
    clearTimeout(timer);
  } };
};
