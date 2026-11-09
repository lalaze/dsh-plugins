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
const expect = source => {
  if (evaluate(source)) return;
  const layout = evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })) })`);
  throw new Error(`UI assertion failed: ${source}\nLayout: ${JSON.stringify(layout)}`);
};
try {
  const result = await build({ absWorkingDir: root, entryPoints: ['test/ui/dashboard.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText;font:14px system-ui}</style></head><body><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
  const file = join(temp, 'index.html'); await writeFile(file, html);
  browser(...(executable ? ['--executable-path', executable] : []), '--allow-file-access', 'open', pathToFileURL(file).href);
  const total = 'document.querySelector(".us-hero-total strong")';
  const requests = n => `document.querySelector(".us-hero-exact")?.textContent === "${n} 次调用"`;
  const rows = 'document.querySelectorAll(".us-breakdown li").length';
  const list = 'document.querySelector(".us-breakdown")?.textContent';
  const tab = label => `[aria-label="分组方式"] button:text-is("${label}")`;
  // Monthly heatmap queries are independent of the headline's selected period.
  const isMonthRequest = `url => {
    const p = new URL(url).searchParams, from = p.get('from'), to = p.get('to');
    if (!from || !to || !from.endsWith('-01') || from.slice(0, 7) !== to.slice(0, 7)) return false;
    const [year, month] = from.split('-').map(Number);
    return Number(to.slice(-2)) === new Date(year, month, 0).getDate();
  }`;
  const mainRequests = `window.fixture.requests.filter(url => !(${isMonthRequest})(url))`;
  const monthRequests = `window.fixture.requests.filter(${isMonthRequest})`;
  const loading = 'document.querySelector(".dsh-usage[aria-busy=true]") || document.querySelector(".us-loading")';
  const rememberHero = () => evaluate(`
    window.fixture.hero = document.querySelector('.us-hero');
    window.fixture.heroTotal = document.querySelector('.us-hero-total strong');
    window.fixture.heroRect = window.fixture.hero.getBoundingClientRect().toJSON();
    window.fixture.heroRemoved = false;
    window.fixture.heroObserver = new MutationObserver(changes => {
      if (changes.some(change => [...change.removedNodes].some(node => node === window.fixture.hero || node.contains(window.fixture.hero)))) window.fixture.heroRemoved = true;
    });
    window.fixture.heroObserver.observe(document.querySelector('.dsh-usage'), { childList: true, subtree: true });
    window.fixture.hold = true; window.fixture.requests = [];
  `);
  const stableHero = `Math.abs(window.fixture.hero.getBoundingClientRect().top - window.fixture.heroRect.top) < 1 && Math.abs(window.fixture.hero.getBoundingClientRect().height - window.fixture.heroRect.height) < 1`;
  const sameHero = `window.fixture.hero?.isConnected && window.fixture.hero === document.querySelector('.us-hero') && window.fixture.heroTotal === document.querySelector('.us-hero-total strong') && !window.fixture.heroRemoved`;
  // The dashboard opens on today, the header pill's total, without first reading all records.
  wait('document.querySelector("[aria-label=时间范围] button[aria-pressed=true]")?.textContent === "今天" && window.fixture.requests.length > 0');
  expect(`${mainRequests}.length > 0 && ${mainRequests}.every(url => { const p = new URL(url).searchParams; return p.get("from") && p.get("from") === p.get("to"); })`);
  wait(`${monthRequests}.length > 0`);
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(`${rows} === 2`); // By provider: deepseek and Claude Code.
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".us-title h2").textContent === "Usage statistics"');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("zh")'); wait('document.querySelector(".us-title h2").textContent === "使用量统计"');
  browser('set', 'viewport', '1120', '900');
  expect(`${requests(3)} && ${total}.textContent === "83" && ${total}.title === "83"`);
  // Hold responses, rather than sleeping, to prove stale data stays mounted during both operations.
  evaluate('Object.defineProperty(document, "hidden", { configurable: true, get: () => true })');
  rememberHero();
  browser('click', '[aria-label="时间范围"] button:text-is("今天")');
  wait(`window.fixture.pending.length > 0 && (${loading})`);
  expect(`${sameHero} && ${stableHero} && ${total}.textContent === "83"`);
  evaluate('window.fixture.releaseRequests()');
  wait(`!(${loading})`); expect(sameHero);
  evaluate('window.fixture.heroObserver.disconnect()');
  browser('click', '[aria-label="时间范围"] button:text-is("全部")');
  wait(requests(3));
  rememberHero(); browser('click', '.us-actions button:has-text("刷新")');
  wait(`window.fixture.pending.length > 0 && (${loading})`);
  expect(`${sameHero} && ${stableHero} && ${requests(3)} && ${total}.textContent === "83"`);
  evaluate('window.fixture.releaseRequests()');
  wait(`!(${loading})`); expect(sameHero);
  evaluate('window.fixture.heroObserver.disconnect(); delete document.hidden');
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
  // A row expands into its details; switching categories collapses it.
  evaluate('[...document.querySelectorAll(".us-row")].find(row => row.textContent.includes("opus")).click()');
  wait('document.querySelector(".us-row[aria-expanded=true] .us-row-name")?.textContent === "opus"');
  expect('document.querySelector(".us-row-detail").textContent.includes("已返回用量 0/1") && document.querySelector(".us-row-detail").textContent.includes("1 失败")');
  browser('click', tab('按模型厂商')); wait(`${list}.includes("Anthropic") && ${list}.includes("DeepSeek") && !document.querySelector(".us-row-detail")`);
  browser('click', tab('按主机')); wait(`${list}.includes("本机") && ${list}.includes("未知主机")`);
  browser('click', tab('按 Workspace')); wait(`${rows} === 1`);
  expect('window.fixture.requests.length === 0');
  evaluate('delete document.hidden');
  browser('snapshot', '-i');
  browser('click', tab('按模型'));
  browser('click', '.us-filters');
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
  wait('document.querySelector(".dsh-usage > [role=alert]")?.textContent.includes("模拟网络错误")');
  expect(`${total}.textContent === "23" && ${rows} === 2`); // Errors retain the last successful report.
  evaluate('window.fixture.fail = false'); browser('click', '.dsh-usage > [role=alert] button');
  wait(`!document.querySelector(".dsh-usage > [role=alert]") && ${rows} === 2`);
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
  const hasRange = (from, to) => `${mainRequests}.length > 0 && new URL(${mainRequests}.at(-1)).searchParams.get('from') === '${from}' && new URL(${mainRequests}.at(-1)).searchParams.get('to') === '${to}'`;
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
  browser('click', '.us-filters');
  browser('set', 'viewport', '1280', '1000'); browser('set', 'media', 'light');
  if (process.env.DSH_TEST_DESKTOP_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_DESKTOP_SCREENSHOT);
  browser('set', 'media', 'dark');
  if (process.env.DSH_TEST_DARK_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_DARK_SCREENSHOT);
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= 390');
  if (process.env.DSH_TEST_SCREENSHOT) browser('screenshot', '--full', process.env.DSH_TEST_SCREENSHOT);
  const errors = browser('errors');
  if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: legacy dashboard scenarios, retained Hero DOM, delayed refresh, and category request isolation');
  // Use the real modal and a frozen local clock for calendar, overflow, and scrollbar coverage.
  const heatmapReady = '!document.querySelector(".us-heatmap[aria-busy=true]") && !!document.querySelector(".us-heatmap-day[data-level]")';
  const day = date => `document.querySelector('.us-heatmap-day[data-date="${date}"]')`;
  const openCalendar = now => {
    const url = new URL(pathToFileURL(file).href);
    url.searchParams.set('now', now); url.searchParams.set('calendar', '1'); url.searchParams.set('dialog', '1');
    browser('open', url.href);
    wait(`document.querySelector('.us-hero') && (${heatmapReady}) && !document.querySelector('.dsh-usage[aria-busy=true]')`);
    evaluate('Object.defineProperty(document, "hidden", { configurable: true, get: () => true })');
    expect('document.querySelector(".us-heatmap h3").textContent === "月度热度图"');
    evaluate('window.fixture.setLocale("en")');
    wait('document.querySelector(".us-heatmap h3").textContent === "Monthly heatmap"');
  };
  const assertMonth = (month, count) => {
    wait(`(${heatmapReady}) && document.querySelector('.us-heatmap-day')?.dataset.date === '${month}-01'`);
    expect(`(() => {
      const grid = document.querySelector('.us-heatmap-grid'), days = [...grid.querySelectorAll('.us-heatmap-day')];
      return grid.children.length === 42 && days.length === ${count} && grid.querySelectorAll('button').length === ${count}
        && days.every((day, i) => day.tagName === 'BUTTON' && day.dataset.date === '${month}-' + String(i + 1).padStart(2, '0') && (day.disabled ? day.dataset.future === 'true' && !day.hasAttribute('data-level') : /^[0-4]$/.test(day.dataset.level)))
        && [...grid.children].filter(child => !child.matches('.us-heatmap-day')).every(child => child.tagName !== 'BUTTON' && !child.querySelector('button'));
    })()`);
    expect(`${monthRequests}.some(url => { const p = new URL(url).searchParams; return p.get('from') === '${month}-01' && p.get('to') === '${month}-${count}' && p.has('tz'); })`);
  };
  openCalendar('2026-10-21T18:00:00');
  assertMonth('2026-10', 31);
  expect(`${day('2026-10-01')}.dataset.level === '1' && ${day('2026-10-02')}.dataset.level === '4'`);
  expect(`${day('2026-10-21')}.getAttribute('aria-current') === 'date' && !${day('2026-10-21')}.disabled`);
  expect(`[...document.querySelectorAll('.us-heatmap-day')].every(day => day.disabled === (day.dataset.date > '2026-10-21'))`);
  expect(`document.querySelector('.us-heatmap [aria-label="Next month"]').disabled`);
  // Calendar metrics are local: they do not fetch or change the headline.
  evaluate('window.fixture.requests = []; window.fixture.heroText = document.querySelector(".us-hero").textContent');
  browser('click', '[aria-label="Heatmap metric"] button:text-is("Requests")');
  expect(`${day('2026-10-01')}.dataset.level === '4' && window.fixture.requests.length === 0 && document.querySelector('.us-hero').textContent === window.fixture.heroText`);
  browser('click', '.us-heatmap-day[data-date="2026-10-01"]');
  expect('document.querySelector(".us-heatmap-readout").textContent.includes("2026-10-01") && document.querySelector(".us-heatmap-readout").textContent.includes("5 requests")');
  browser('click', '[aria-label="Heatmap metric"] button:text-is("Token")');
  expect(`${day('2026-10-01')}.dataset.level === '1' && window.fixture.requests.length === 0`);
  browser('click', '.us-heatmap-day[data-date="2026-10-01"]');
  expect('document.querySelector(".us-heatmap-readout").textContent.includes("5 Token")');
  // All four presets must leave the full-month calendar and its request stream alone.
  for (const label of ['All', 'Last 7 days', 'Last 30 days', 'Today']) {
    evaluate('window.fixture.requests = []');
    browser('click', `[aria-label="Time range"] button:text-is("${label}")`);
    wait(`${mainRequests}.length > 0 && !document.querySelector('.dsh-usage[aria-busy=true]')`);
    expect(`${monthRequests}.length === 0 && document.querySelector('.us-heatmap-day').dataset.date === '2026-10-01' && ${day('2026-10-01')}.dataset.level === '1'`);
  }
  console.log('PASS: monthly calendar structure, metric changes, and period independence');
  // Provider/model/session filters are shared, but calendar requests always retain full-month dates.
  browser('click', '.us-filters');
  const filteredMonth = (provider, model, sessionId) => `${monthRequests}.some(url => {
    const p = new URL(url).searchParams;
    return p.get('from') === '2026-10-01' && p.get('to') === '2026-10-31'
      && (p.get('provider') || '') === '${provider}' && (p.get('model') || '') === '${model}' && (p.get('sessionId') || '') === '${sessionId}';
  })`;
  evaluate('window.fixture.requests = []');
  browser('select', 'select[aria-label="Provider"]', 'claude-ssh-dev');
  wait(`(${heatmapReady}) && (${filteredMonth('claude-ssh-dev', '', '')})`);
  expect(`${day('2026-10-01')}.dataset.level === '0' && ${day('2026-10-20')}.dataset.level === '4'`);
  browser('select', 'select[aria-label="Model"]', 'sonnet');
  wait(`(${heatmapReady}) && (${filteredMonth('claude-ssh-dev', 'sonnet', '')})`);
  expect(`${day('2026-10-21')}.dataset.level === '0' && ${day('2026-10-20')}.dataset.level === '4'`);
  browser('fill', '[aria-label="Session ID"]', 'remote-session');
  wait(`(${heatmapReady}) && (${filteredMonth('claude-ssh-dev', 'sonnet', 'remote-session')})`);
  expect(`${day('2026-10-20')}.dataset.level === '4'`);
  browser('fill', '[aria-label="Session ID"]', 'missing-session');
  wait(`(${heatmapReady}) && (${filteredMonth('claude-ssh-dev', 'sonnet', 'missing-session')})`);
  expect('[...document.querySelectorAll(".us-heatmap-day")].every(day => day.disabled ? !day.hasAttribute("data-level") : day.dataset.level === "0") && document.querySelector(".us-heatmap-footer").textContent.includes("No usage this month")');
  browser('click', 'button:text-is("Reset filters")');
  wait(`(${heatmapReady}) && ${day('2026-10-01')}?.dataset.level === '1'`);
  // Switching months must not display the preceding month's colors while its response is held.
  evaluate('window.fixture.requests = []; window.fixture.hold = true; window.fixture.calendarHero = document.querySelector(".us-hero")');
  browser('click', '.us-heatmap [aria-label="Previous month"]');
  wait('window.fixture.pending.length > 0 && document.querySelector(".us-heatmap[aria-busy=true]")');
  expect('document.querySelector(".us-heatmap-grid").children.length === 42 && document.querySelector(".us-heatmap-day").dataset.date === "2026-09-01" && !document.querySelector(".us-heatmap-day[data-level]") && document.querySelector(".us-heatmap-readout").textContent.includes("Loading month")');
  expect(`${mainRequests}.length === 0 && window.fixture.calendarHero === document.querySelector('.us-hero') && !document.querySelector('.dsh-usage[aria-busy=true]')`);
  evaluate('window.fixture.releaseRequests()');
  assertMonth('2026-09', 30);
  expect('[...document.querySelectorAll(".us-heatmap-day")].every(day => day.dataset.level === "0" && !day.disabled) && document.querySelector(".us-heatmap-footer").textContent.includes("No usage this month")');
  browser('click', '.us-heatmap [aria-label="Next month"]');
  assertMonth('2026-10', 31);
  expect(`${day('2026-10-01')}.dataset.level === '1' && ${mainRequests}.length === 0`);
  // Resolve the newer month first and then the aborted response: old data must not win the race.
  evaluate('window.fixture.requests = []; window.fixture.hold = true');
  browser('click', '.us-heatmap [aria-label="Previous month"]');
  wait('window.fixture.pending.length === 1');
  browser('click', '.us-heatmap [aria-label="Previous month"]');
  wait('window.fixture.pending.length === 2');
  evaluate('window.fixture.pending.splice(1, 1)[0].release()');
  assertMonth('2026-08', 31);
  evaluate('window.fixture.releaseRequests(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assertMonth('2026-08', 31);
  expect(`${mainRequests}.length === 0`);
  browser('click', '.us-heatmap button:text-is("This month")'); assertMonth('2026-10', 31);
  // The headline has the same stale-response protection, without removing its existing DOM.
  rememberHero();
  browser('click', '[aria-label="Time range"] button:text-is("All")');
  wait('window.fixture.pending.length === 1');
  browser('click', '[aria-label="Time range"] button:text-is("Last 7 days")');
  wait('window.fixture.pending.length === 2');
  expect(sameHero);
  evaluate('window.fixture.pending.splice(1, 1)[0].release()');
  wait(`!document.querySelector('.dsh-usage[aria-busy=true]') && ${total}.textContent === '83'`);
  evaluate('window.fixture.releaseRequests(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  expect(`${sameHero} && ${total}.textContent === '83' && document.querySelector('[aria-label="Time range"] [aria-pressed=true]').textContent === 'Last 7 days'`);
  evaluate('window.fixture.heroObserver.disconnect()');
  console.log('PASS: calendar filters, empty month, and stale-response protection');
  // Hidden scrollbars must not disable scrolling, in desktop/mobile and both color schemes.
  const assertDialogScroll = () => {
    expect(`(() => { const body = document.querySelector('.us-dialog-body'), css = getComputedStyle(body);
      return css.scrollbarWidth === 'none' && css.overflowY === 'auto' && body.scrollHeight > body.clientHeight;
    })()`);
    evaluate('document.querySelector(".us-dialog-body").scrollTop = 0');
    evaluate('document.querySelector(".us-dialog-body").scrollBy(0, 240)');
    wait('document.querySelector(".us-dialog-body").scrollTop > 0');
    expect(`(() => { const body = document.querySelector('.us-dialog-body'), calendar = document.querySelector('.us-heatmap');
      return document.documentElement.scrollWidth <= innerWidth && body.scrollWidth <= body.clientWidth + 1 && calendar.scrollWidth <= calendar.clientWidth + 1;
    })()`);
  };
  for (const media of ['light', 'dark']) {
    browser('set', 'media', media);
    browser('set', 'viewport', '1280', '1000'); assertDialogScroll();
    const color = evaluate('getComputedStyle(document.querySelector(".us-dialog")).backgroundColor');
    if (media === 'light') evaluate(`window.fixture.lightBackground = ${JSON.stringify(color)}`);
    else expect(`window.fixture.lightBackground !== ${JSON.stringify(color)}`);
    for (const width of [390, 320]) { browser('set', 'viewport', String(width), '844'); assertDialogScroll(); }
  }
  browser('set', 'viewport', '390', '844');
  evaluate('document.querySelector(".us-dialog-body").scrollTop = 0');
  rememberHero(); browser('click', '.us-actions button:has-text("Refresh")');
  wait('window.fixture.pending.length > 0 && document.querySelector(".dsh-usage[aria-busy=true]")');
  expect(`${sameHero} && ${stableHero}`);
  evaluate('window.fixture.releaseRequests()');
  wait('!document.querySelector(".dsh-usage[aria-busy=true]")');
  expect(sameHero); evaluate('window.fixture.heroObserver.disconnect()');
  if (process.env.DSH_TEST_HEATMAP_SCREENSHOT) {
    evaluate('document.querySelector(".us-heatmap").scrollIntoView({ block: "center" })');
    browser('screenshot', '--full', process.env.DSH_TEST_HEATMAP_SCREENSHOT);
  }
  const calendarErrors = browser('errors');
  if (calendarErrors.errors?.length) throw new Error(JSON.stringify(calendarErrors));
  // Separate frozen clocks exercise leap day, non-leap February, and a year boundary without 30 clicks.
  openCalendar('2024-03-15T12:00:00');
  browser('click', '.us-heatmap [aria-label="Previous month"]');
  assertMonth('2024-02', 29);
  expect(`${day('2024-02-29')}.dataset.level === '4' && !${day('2024-02-29')}.disabled`);
  browser('click', '.us-heatmap [aria-label="Previous month"]'); assertMonth('2024-01', 31);
  browser('click', '.us-heatmap [aria-label="Previous month"]'); assertMonth('2023-12', 31);
  browser('click', '.us-heatmap [aria-label="Next month"]'); assertMonth('2024-01', 31);
  openCalendar('2025-03-15T12:00:00');
  browser('click', '.us-heatmap [aria-label="Previous month"]'); assertMonth('2025-02', 28);
  expect(`!${day('2025-02-29')}`);
  const finalErrors = browser('errors');
  if (finalErrors.errors?.length) throw new Error(JSON.stringify(finalErrors));
  console.log('PASS: opening on today, headline totals and partial-records link, retained Hero DOM during delayed date changes/refresh, all category tabs without refetching, expandable rows and show-all, trend/category independence, date presets and local-midnight rollover, session/date filters, CSV contents, empty state, error recovery, independent monthly heatmap requests/filters/metrics, 42 cells, empty/leap/non-leap/year-boundary months, future days, hidden but working dialog scrollbars, light/dark and 390/320px width');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
