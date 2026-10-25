import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'dsh-usage-ui-'));
const session = `dsh-usage-ui-${process.pid}`;
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
const expect = source => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${source}`); };
try {
  const result = await build({ absWorkingDir: root, entryPoints: ['test/ui/dashboard.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText;font:14px system-ui}</style></head><body><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
  const file = join(temp, 'index.html'); await writeFile(file, html);
  browser(...(executable ? ['--executable-path', executable] : []), '--allow-file-access', 'open', pathToFileURL(file).href);
  const total = `document.querySelector(${JSON.stringify('article[aria-label="总 Token"] strong')})`;
  const count = `document.querySelector(${JSON.stringify('article[aria-label="调用次数"] strong')})`;
  wait('document.querySelectorAll("tbody tr").length === 3');
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".us-title h2").textContent === "Usage statistics"');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("zh")'); wait('document.querySelector(".us-title h2").textContent === "使用量统计"');
  browser('set', 'viewport', '1120', '900');
  expect(`${count}.textContent === "3" && ${total}.textContent === "83"`);
  expect('document.querySelectorAll(".us-bar-hit").length === 2 && document.querySelector("[aria-label=来源占比]").textContent.includes("72.3%")');
  browser('click', '.us-bar-hit:first-child');
  browser('select', '[aria-label="分组方式"]', 'day');
  wait('document.querySelectorAll("tbody tr").length === 2');
  expect('document.querySelectorAll(".us-bar-hit").length === 2');
  browser('snapshot', '-i');
  browser('click', 'nav[aria-label="调用来源"] button:has-text("Claude SSH")');
  wait(`${count}?.textContent === "2"`);
  expect(`${total}.textContent === "23" && document.body.textContent.includes("已返回用量 1/2")`);
  browser('select', '[aria-label="分组方式"]', 'model');
  wait('document.querySelector("tbody").textContent.includes("sonnet")');
  expect('!document.querySelector("tbody").textContent.includes("deepseek-chat")');
  browser('click', '.us-filters summary');
  browser('fill', '[aria-label="会话 ID"]', 'missing-session');
  wait('document.body.textContent.includes("暂无符合条件的记录")');
  browser('fill', '[aria-label="会话 ID"]', 'remote-session');
  wait('document.querySelectorAll("tbody tr").length === 2');
  const csvPath = join(temp, 'usage.csv');
  browser('download', 'button:has-text("导出 CSV")', csvPath);
  expect('window.fixture.requests.some(url => url.includes("source=claude-ssh") && url.includes("sessionId=remote-session") && url.includes("format=csv"))');
  const csv = await readFile(csvPath, 'utf8');
  if (!csv.includes('claude-ssh-dev / sonnet') || csv.includes('deepseek-chat')) throw new Error('CSV did not preserve the active filters');
  evaluate('window.fixture.fail = true'); browser('click', 'button:has-text("刷新")');
  wait('document.querySelector("[role=alert]")?.textContent.includes("模拟网络错误")');
  evaluate('window.fixture.fail = false'); browser('click', '[role=alert] button');
  wait('!document.querySelector("[role=alert]") && document.querySelectorAll("tbody tr").length === 2');
  browser('click', 'nav[aria-label="调用来源"] button:has-text("全部来源")'); browser('fill', '[aria-label="会话 ID"]', '');
  browser('click', 'button:has-text("自定义")');
  browser('fill', '[aria-label="开始日期"]', '2026-10-21'); browser('fill', '[aria-label="结束日期"]', '2026-10-21');
  wait(`${count}?.textContent === "2" && ${total}?.textContent === "60"`);
  expect('document.querySelectorAll(".us-bar-hit").length === 1');
  browser('click', 'button:has-text("近 7 天")');
  wait('window.fixture.requests.at(-1).includes("from=") && document.querySelector("[aria-label=时间范围] button[aria-pressed=true]").textContent === "近 7 天"');
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(`${count}?.textContent === "3"`);
  // Move the browser clock across UTC midnight without waiting a real day.
  evaluate(`window.fixture.now = '2026-10-21T23:59:59Z'; window.fixture.NativeDate = Date;
    window.Date = class extends window.fixture.NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.fixture.now])); }
      static now() { return new window.fixture.NativeDate(window.fixture.now).getTime(); }
    }`);
  const hasRange = (from, to) => `new URL(window.fixture.requests.at(-1)).searchParams.get('from') === '${from}' && new URL(window.fixture.requests.at(-1)).searchParams.get('to') === '${to}'`;
  browser('click', '[aria-label="时间范围"] button:text-is("今天")');
  wait(hasRange('2026-10-21', '2026-10-21'));
  evaluate("window.fixture.now = '2026-10-22T00:00:01Z'");
  browser('click', 'button:has-text("刷新")');
  wait(hasRange('2026-10-22', '2026-10-22'));
  wait(`${count}?.textContent === "0"`);
  browser('click', '[aria-label="时间范围"] button:text-is("近 7 天")');
  wait(hasRange('2026-10-16', '2026-10-22'));
  evaluate("window.fixture.now = '2026-10-23T00:00:01Z'");
  wait(hasRange('2026-10-17', '2026-10-23')); // Exercise the automatic poll.
  browser('click', '[aria-label="时间范围"] button:text-is("近 30 天")');
  wait(hasRange('2026-09-24', '2026-10-23'));
  evaluate("window.fixture.now = '2026-10-24T00:00:01Z'");
  browser('click', 'button:has-text("刷新")');
  wait(hasRange('2026-09-25', '2026-10-24'));
  browser('click', '[aria-label="时间范围"] button:text-is("自定义")');
  evaluate("window.fixture.now = '2026-10-25T00:00:01Z'; window.fixture.requests = []");
  browser('click', 'button:has-text("刷新")');
  wait('window.fixture.requests.length > 0');
  expect(hasRange('2026-09-25', '2026-10-24'));
  evaluate('window.Date = window.fixture.NativeDate');
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(`${count}?.textContent === "3"`);
  evaluate('window.fixture.demo = true'); browser('click', 'button:has-text("刷新")');
  wait('document.querySelectorAll(".us-bar-hit").length === 21');
  browser('click', '[aria-label="趋势指标"] button:has-text("调用次数")');
  expect('document.querySelector(".us-chart-readout").textContent.includes("588 次调用")');
  browser('click', '[aria-label="趋势指标"] button:has-text("Token")');
  browser('select', '[aria-label="分组方式"]', 'day');
  wait('document.querySelectorAll("tbody tr").length === 10');
  browser('click', '[aria-label="下一页"]');
  wait('document.querySelector(".us-pagination").textContent.includes("第 2 / 3 页")');
  browser('click', '[aria-label="下一页"]');
  wait('document.querySelectorAll("tbody tr").length === 1');
  expect('document.querySelectorAll(".us-bar-hit").length === 21');
  browser('select', '[aria-label="分组方式"]', 'model');
  wait('document.querySelectorAll("tbody tr").length === 3');
  browser('click', '.us-filters summary');
  browser('set', 'viewport', '1280', '1000'); browser('set', 'media', 'light');
  if (process.env.DSH_TEST_DESKTOP_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_DESKTOP_SCREENSHOT);
  browser('set', 'media', 'dark');
  if (process.env.DSH_TEST_DARK_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_DARK_SCREENSHOT);
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= 390');
  if (process.env.DSH_TEST_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_SCREENSHOT);
  const errors = browser('errors');
  if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: dashboard totals, source tabs/share, trend/group independence, date presets and UTC rollover, session/date filters, CSV contents, empty state, error recovery, light/dark and mobile width');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
