import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Set DSH_TEST_SCREENSHOTS=<dir> to keep light and dark screenshots of the fixture.
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'dsh-session-models-ui-'));
const session = `dsh-session-models-ui-${process.pid}`;
const shots = process.env.DSH_TEST_SCREENSHOTS && resolve(process.env.DSH_TEST_SCREENSHOTS);
let executable = process.env.DSH_TEST_BROWSER_PATH;
if (!executable && process.platform === 'darwin') {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(chrome); executable = chrome; } catch {}
}
function browser(...args) {
  const raw = execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(raw); if (!result.success) throw new Error(result.error ?? 'Browser command failed'); return result.data;
}
const evaluate = source => browser('eval', '-b', Buffer.from(source).toString('base64')).result;
const wait = source => browser('wait', '--fn', source);
const expect = (source, label = source) => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${label}`); };
const cell = id => `document.querySelector('[data-row-key="session:${id}"] > span')`;
const before = (id, property) => `getComputedStyle(${cell(id)}, '::before').${property}`;
const transform = (id, selector) => `getComputedStyle(${cell(id)}.querySelector(${JSON.stringify(selector)})).transform`;

try {
  const result = await build({ absWorkingDir: root, entryPoints: ['test/ui/sidebar.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
  const file = join(temp, 'index.html'); await writeFile(file, html);
  browser(...(executable ? ['--executable-path', executable] : []), '--allow-file-access', 'open', pathToFileURL(file).href);
  wait('document.getElementById("dsh-session-models")?.textContent.includes("session:claude-done")');

  // Every brand paints its icon, and the host's status mark becomes a corner badge.
  expect(`${before('claude-done', 'backgroundColor')} === "rgb(217, 119, 87)"`, 'Claude icon color');
  expect(`${before('claude-done', 'maskImage')}.includes("url(")`, 'Claude icon mask');
  expect(`${transform('claude-done', '[data-state]')} === "matrix(0.85, 0, 0, 0.85, 5.5, 5.5)"`, 'done dot badge');
  expect(`${transform('openai-running', 'svg[data-state]')} === "matrix(0.72, 0, 0, 0.72, 5.5, 5.5)"`, 'running spinner badge');
  expect(`getComputedStyle(${cell('openai-running')}.querySelector('svg')).color === getComputedStyle(document.querySelector('.title')).color`, 'badged spinner uses the label color');
  expect(`${before('openai-running', 'backgroundColor')} === getComputedStyle(document.querySelector('.title')).color`, 'OpenAI follows the label color');
  expect(`${before('deepseek-warning', 'backgroundColor')} === "rgb(77, 107, 254)"`, 'DeepSeek icon');
  expect(`${before('gemini-idle', 'backgroundColor')} === "rgb(49, 134, 255)" && ${cell('gemini-idle')}.children.length === 0`, 'idle Gemini row shows only the icon');
  expect(`${transform('qwen-schedule', '[data-session-schedule-mark]')} === "matrix(0.6, 0, 0, 0.6, 5.5, 5.5)"`, 'schedule mark badge');
  expect(`${before('kimi-error', 'maskImage')}.includes("url(")`, 'Kimi icon');
  expect(`${before('generic-done', 'maskImage')}.includes("url(")`, 'generic icon for unknown vendors');
  expect(`${transform('grok-wrapped', '.mark')} === "matrix(0.85, 0, 0, 0.85, 5.5, 5.5)" && ${transform('grok-wrapped', '[data-state]')} === "none"`, 'a wrapped done dot moves into the corner');
  expect(`getComputedStyle(${cell('grok-wrapped')}).getPropertyValue('--dsm-cut') === "4px"`, 'a wrapped done dot keeps its cut-out');
  expect(`${before('grok-wrapped', 'backgroundColor')} === getComputedStyle(document.querySelector('.title')).color`, 'Grok follows the label color');
  expect(`${transform('openai-remote', '[data-dsh-remote-mark]')} === "matrix(0.6, 0, 0, 0.6, 5.5, 5.5)" && getComputedStyle(${cell('openai-remote')}).getPropertyValue('--dsm-cut') === "5px"`, 'a leading-slot mark becomes the corner badge');
  expect(`(() => { const m = ${cell('openai-remote')}.querySelector('[data-dsh-remote-mark] > span').getBoundingClientRect(), c = ${cell('openai-remote')}.getBoundingClientRect(); return m.left - c.left > 10 && m.top - c.top > 12; })()`, 'the remote dot sits in the lower-right corner');
  // Archived rows stay blank, matching the host.
  expect(`${before('archived', 'backgroundColor')} === "rgba(0, 0, 0, 0)"`, 'archived row has no icon');

  // A row without a known model keeps the host dot until its projection read lands.
  expect('window.fixture.refreshed.includes("unread-done") && !window.fixture.refreshed.includes("claude-done")', 'only rows without a model are read');
  wait(`${before('unread-done', 'maskImage')}.includes("url(")`);
  expect(`${transform('unread-done', '[data-state]')} === "matrix(0.85, 0, 0, 0.85, 5.5, 5.5)"`, 'badge after projection read');

  // Decoration never moves the host layout.
  expect(`new Set([...document.querySelectorAll('[data-row-key] > .title')].map(t => t.getBoundingClientRect().left)).size === 1`, 'titles stay aligned');
  expect(`[...document.querySelectorAll('[data-row-key] > .slot')].every(s => { const r = s.getBoundingClientRect(); return r.width === 16 && r.height === 20; })`, 'leading cell stays 16x20');

  // Hover card line follows the DSH language.
  wait('document.querySelector(".dsm-hover-model")?.textContent === "sonnet"');
  expect('document.querySelector(".dsm-hover-cli").textContent === "Remote Claude Code"', 'English remote label');
  evaluate('window.fixture.setLocale("zh-CN")');
  wait('document.querySelector(".dsm-hover-cli")?.textContent === "远程 Claude Code"');

  if (shots) {
    evaluate('document.body.style.zoom = "2.5"');
    browser('screenshot', join(shots, 'sidebar-light.png'));
    browser('set', 'media', 'dark');
    browser('screenshot', join(shots, 'sidebar-dark.png'));
  }
  console.log('Session model sidebar UI checks passed');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
