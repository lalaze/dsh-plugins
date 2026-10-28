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
  const total = 'document.querySelector(".us-hero-total strong")';
  const requests = n => `document.querySelector(".us-hero-exact")?.textContent.endsWith(" ${n} 次调用")`;
  const rows = 'document.querySelectorAll(".us-breakdown li").length';
  const list = 'document.querySelector(".us-breakdown")?.textContent';
  const tab = label => `[aria-label="分组方式"] button:text-is("${label}")`;
  wait(`${rows} === 2`); // By provider: deepseek and Claude Code.
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".us-title h2").textContent === "Usage statistics"');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("zh")'); wait('document.querySelector(".us-title h2").textContent === "使用量统计"');
  browser('set', 'viewport', '1120', '900');
  expect(`${requests(3)} && ${total}.textContent === "83" && document.querySelector(".us-hero-exact").textContent === "83 Token · 3 次调用"`);
  expect('document.querySelectorAll(".us-bar-hit").length === 2 && document.querySelector(".us-range").textContent.startsWith("全部记录 · ")');
  expect(`${list}.includes("Claude Code") && document.querySelector(".us-row-name").textContent === "deepseek"`);
  // The failed remote turn returned no usage: the headline is marked partial and links to what needs attention.
  expect('document.querySelector(".us-sources-head").getAttribute("aria-expanded") === "false" && document.querySelector(".us-sources-status").textContent === "1 项需关注"');
  browser('click', '.us-partial');
  wait('document.querySelector(".us-sources-head").getAttribute("aria-expanded") === "true"');
  expect('document.querySelector(".us-sources-detail").textContent.includes("1 次调用未返回用量") && document.querySelector(".us-sources").textContent.includes("已返回用量 1/2")');
  browser('click', '.us-bar-hit:first-child');
  // Categories drive the breakdown without another request. Polls skip hidden pages, so hide this one meanwhile.
  evaluate('Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); window.fixture.requests = []');
  browser('click', tab('按模型'));
  wait(`${rows} === 3 && ${list}.includes("sonnet")`);
  expect('document.querySelectorAll(".us-bar-hit").length === 2 && window.fixture.requests.length === 0');
  evaluate('delete document.hidden');
  // A row expands into its details; switching categories collapses it.
  evaluate('[...document.querySelectorAll(".us-row")].find(row => row.textContent.includes("opus")).click()');
  wait('document.querySelector(".us-row[aria-expanded=true] .us-row-name")?.textContent === "opus"');
  expect('document.querySelector(".us-row-detail").textContent.includes("已返回用量 0/1") && document.querySelector(".us-row-detail").textContent.includes("1 失败")');
  browser('click', tab('按模型厂商')); wait(`${list}.includes("Anthropic") && ${list}.includes("DeepSeek") && !document.querySelector(".us-row-detail")`);
  browser('click', tab('按主机')); wait(`${list}.includes("本机") && ${list}.includes("未知主机")`);
  browser('click', tab('按 Workspace')); wait(`${rows} === 1`);
  browser('snapshot', '-i');
  browser('click', tab('按模型'));
  browser('click', '.us-filters summary');
  browser('fill', '[aria-label="会话 ID"]', 'remote-session');
  wait(requests(2));
  expect(`${total}.textContent === "23" && document.querySelector(".us-sources").textContent.includes("已返回用量 1/2")`);
  wait(`${list}.includes("sonnet")`);
  expect(`!${list}.includes("deepseek-chat")`);
  browser('fill', '[aria-label="会话 ID"]', 'missing-session');
  wait('document.body.textContent.includes("暂无符合条件的记录")');
  browser('fill', '[aria-label="会话 ID"]', 'remote-session');
  wait(`${rows} === 2`);
  const csvPath = join(temp, 'usage.csv');
  browser('download', 'button:has-text("导出 CSV")', csvPath);
  expect('window.fixture.requests.some(url => url.includes("groupBy=model") && url.includes("sessionId=remote-session") && url.includes("format=csv"))');
  const csv = await readFile(csvPath, 'utf8');
  if (!csv.includes('"sonnet"') || csv.includes('deepseek-chat')) throw new Error('CSV did not follow the category and filters');
  evaluate('window.fixture.fail = true'); browser('click', 'button:has-text("刷新")');
  wait('document.querySelector("[role=alert]")?.textContent.includes("模拟网络错误")');
  evaluate('window.fixture.fail = false'); browser('click', '[role=alert] button');
  wait(`!document.querySelector("[role=alert]") && ${rows} === 2`);
  browser('fill', '[aria-label="会话 ID"]', '');
  browser('click', 'button:has-text("自定义")');
  browser('fill', '[aria-label="开始日期"]', '2026-10-21'); browser('fill', '[aria-label="结束日期"]', '2026-10-21');
  wait(`${requests(2)} && ${total}?.textContent === "60"`);
  // A single day is the headline total; the trend needs at least two buckets.
  expect('!document.querySelector(".us-chart") && document.querySelector(".us-range").textContent.startsWith("2026-10-21 · ")');
  browser('click', 'button:has-text("近 7 天")');
  wait('window.fixture.requests.at(-1).includes("from=") && document.querySelector("[aria-label=时间范围] button[aria-pressed=true]").textContent === "近 7 天"');
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(requests(3));
  // Move the browser clock across local midnight without waiting a real day; times without `Z` are local.
  evaluate(`window.fixture.now = '2026-10-21T23:59:59'; window.fixture.NativeDate = Date;
    window.Date = class extends window.fixture.NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.fixture.now])); }
      static now() { return new window.fixture.NativeDate(window.fixture.now).getTime(); }
    }`);
  const hasRange = (from, to) => `new URL(window.fixture.requests.at(-1)).searchParams.get('from') === '${from}' && new URL(window.fixture.requests.at(-1)).searchParams.get('to') === '${to}'`;
  browser('click', '[aria-label="时间范围"] button:text-is("今天")');
  wait(hasRange('2026-10-21', '2026-10-21'));
  evaluate("window.fixture.now = '2026-10-22T00:00:01'");
  browser('click', 'button:has-text("刷新")');
  wait(hasRange('2026-10-22', '2026-10-22'));
  wait(requests(0));
  browser('click', '[aria-label="时间范围"] button:text-is("近 7 天")');
  wait(hasRange('2026-10-16', '2026-10-22'));
  evaluate("window.fixture.now = '2026-10-23T00:00:01'");
  wait(hasRange('2026-10-17', '2026-10-23')); // Exercise the automatic poll.
  browser('click', '[aria-label="时间范围"] button:text-is("近 30 天")');
  wait(hasRange('2026-09-24', '2026-10-23'));
  evaluate("window.fixture.now = '2026-10-24T00:00:01'");
  browser('click', 'button:has-text("刷新")');
  wait(hasRange('2026-09-25', '2026-10-24'));
  browser('click', '[aria-label="时间范围"] button:text-is("自定义")');
  evaluate("window.fixture.now = '2026-10-25T00:00:01'; window.fixture.requests = []");
  browser('click', 'button:has-text("刷新")');
  wait('window.fixture.requests.length > 0');
  expect(hasRange('2026-09-25', '2026-10-24'));
  evaluate('window.Date = window.fixture.NativeDate');
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(requests(3));
  evaluate('window.fixture.demo = true'); browser('click', 'button:has-text("刷新")');
  wait('document.querySelectorAll(".us-bar-hit").length === 21');
  browser('click', '[aria-label="趋势指标"] button:has-text("调用次数")');
  expect('document.querySelector(".us-chart-readout").textContent.includes("770 次调用")');
  browser('click', '[aria-label="趋势指标"] button:has-text("Token")');
  evaluate('window.fixture.demo = false; window.fixture.workspaces = true'); browser('click', 'button:has-text("刷新")');
  browser('click', tab('按 Workspace'));
  wait(`${rows} === 8`);
  browser('click', 'button:has-text("显示全部 21 项")');
  wait(`${rows} === 21`);
  browser('click', 'button:has-text("收起")');
  wait(`${rows} === 8`);
  evaluate('window.fixture.workspaces = false; window.fixture.demo = true'); browser('click', 'button:has-text("刷新")');
  browser('click', tab('按 Provider'));
  wait(`document.querySelectorAll(".us-bar-hit").length === 21 && ${rows} === 3`);
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
  console.log('PASS: headline totals and partial-records link, category tabs driving the breakdown/CSV without refetching, expandable rows and show-all, trend/category independence, date presets and local-midnight rollover, session/date filters, CSV contents, empty state, error recovery, light/dark and mobile width');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
