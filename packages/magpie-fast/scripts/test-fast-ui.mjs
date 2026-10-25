import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const session = `dsh-gpt-fast-${process.pid}`;
const server = spawn(process.execPath, [fileURLToPath(new URL('./preview-fast.mjs', import.meta.url))], { env: { ...process.env, DSH_FAST_PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  let output = ''; server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/100\.96\.195\.115:\d+\//); if (match) resolve(match[0]); });
  server.once('error', reject); server.once('exit', code => reject(new Error(`Preview exited: ${code}`)));
});
function browser(...args) {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000, maxBuffer: 4 * 1024 * 1024 }));
  if (!result.success) throw new Error(result.error ?? 'Browser command failed'); return result.data;
}
const evaluate = source => browser('eval', '-b', Buffer.from(source).toString('base64')).result;
const wait = source => browser('wait', '--fn', source);
const expect = source => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${source}`); };
const button = 'document.querySelector("[data-dsh-gpt-fast] button")';
const ready = `${button} && !${button}.disabled && ${button}.getAttribute('aria-busy') !== 'true'`;
try {
  browser('--executable-path', process.env.DSH_TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'open', base);
  wait(ready); console.log(JSON.stringify(browser('snapshot', '-i')));
  expect('window.fixture.slot.name === "conversation.input.left" && window.fixture.slot.order === 10');
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".dsh-fast-button").getAttribute("aria-label") === "Turn on GPT Fast"');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("zh")'); wait('document.querySelector(".dsh-fast-button").getAttribute("aria-label") === "开启 GPT Fast"');
  browser('set', 'viewport', '1120', '900');
  browser('click', '[aria-label="开启 GPT Fast"]'); wait(`${button}.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('open', base); wait(`${button}?.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('select', '[aria-label="模型"]', 'claude'); wait(`!${button}`);
  browser('select', '[aria-label="模型"]', 'gpt'); wait(`${button}?.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('select', '[aria-label="会话"]', 'session-b'); wait(`${button}?.getAttribute('aria-pressed') === 'false' && ${ready}`);
  browser('click', '[aria-label="开启 GPT Fast"]'); wait(`${button}.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('select', '[aria-label="会话"]', 'session-a'); wait(`${button}?.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('click', '[aria-label="关闭 GPT Fast"]'); wait(`${button}.getAttribute('aria-pressed') === 'false' && ${ready}`);
  evaluate('window.fixture.failWrite = true'); browser('click', '[aria-label="开启 GPT Fast"]'); wait('document.querySelector("[role=alert]")');
  expect(`${button}.getAttribute('aria-pressed') === 'false'`);
  evaluate('window.fixture.failWrite = false'); browser('click', '[aria-label="开启 GPT Fast"]'); wait(`${button}.getAttribute('aria-pressed') === 'true' && ${ready}`);
  expect('!document.querySelector("[role=alert]")');
  browser('select', '[aria-label="模型"]', 'unsupported'); wait(`${button}?.disabled === true && ${button}?.title.includes('API')`);
  browser('select', '[aria-label="模型"]', 'gpt'); wait(ready);
  // Keyboard activation must work without requiring pointer events.
  evaluate(`${button}.focus()`); browser('press', 'Space'); wait(`${button}.getAttribute('aria-pressed') === 'false' && ${ready}`);
  browser('press', 'Enter'); wait(`${button}.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('select', '[aria-label="会话"]', 'session-b'); wait(`${button}?.getAttribute('aria-pressed') === 'true' && ${ready}`);
  browser('set', 'viewport', '900', '430'); browser('set', 'media', 'dark');
  if (process.env.DSH_FAST_SCREENSHOT_DIR) {
    await mkdir(process.env.DSH_FAST_SCREENSHOT_DIR, { recursive: true });
    browser('screenshot', '--full', join(process.env.DSH_FAST_SCREENSHOT_DIR, 'gpt-fast-dark.png'));
    browser('set', 'media', 'light'); browser('screenshot', '--full', join(process.env.DSH_FAST_SCREENSHOT_DIR, 'gpt-fast-light.png'));
  }
  browser('set', 'viewport', '390', '844'); expect('document.documentElement.scrollWidth <= 390');
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: GPT-only lightning, exact slot, toggle persistence, session isolation, API errors, unsupported providers, keyboard, light/dark/mobile');
} finally {
  try { browser('close'); } catch {}
  server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
