import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const session = `dsh-magpie-quota-${process.pid}`;
const server = spawn(process.execPath, [fileURLToPath(new URL('./preview-quota.mjs', import.meta.url))], { env: { ...process.env, DSH_QUOTA_PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const browser = (...args) => {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000, maxBuffer: 4 * 1024 * 1024 }));
  if (!result.success) throw new Error(result.error || 'Browser command failed'); return result.data;
};
const evaluate = source => browser('eval', '-b', Buffer.from(source).toString('base64')).result;
const wait = source => browser('wait', '--fn', source);
const expect = source => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${source}`); };
const shots = process.env.DSH_QUOTA_SCREENSHOT_DIR;
const dialog = 'document.querySelector("[role=dialog]")';
const chips = 'document.querySelectorAll(".mq-chip")';
const snapshot = () => browser('snapshot', '-i');
try {
  const base = await new Promise((resolve, reject) => {
    let output = ''; server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/100\.96\.195\.115:\d+\//); if (match) resolve(match[0]); });
    server.once('error', reject); server.once('exit', code => reject(new Error(`Preview exited: ${code}`)));
  });
  browser('--executable-path', process.env.DSH_TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'open', base);
  browser('set', 'viewport', '1120', '780'); browser('set', 'media', 'dark');
  wait(`${chips}.length === 4`); snapshot();
  expect('window.fixture.registrations.some(s => s.name === "conversation.composer.dock") && window.fixture.registrations.some(s => s.name === "settings.section")');
  expect('Array.from(document.querySelectorAll(".mq-chip-value")).map(e=>e.textContent).join(",") === "80%,63%,100%,88%"');
  if (shots) { await mkdir(shots, { recursive: true }); browser('screenshot', join(shots, 'quota-dark.png')); }
  browser('click', '.mq-chip:nth-child(2)'); wait(dialog); snapshot();
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".mq-panel-top strong").textContent === "Account quota"');
  expect('document.querySelector(".mq-popover").textContent.includes("Resets in")');
  evaluate('window.fixture.setLocale("zh")'); wait('document.querySelector(".mq-panel-top strong").textContent === "账号额度"');
  expect('document.querySelectorAll("[role=progressbar]").length === 2 && document.querySelector(".mq-popover").textContent.includes("重置")');
  expect('(()=>{const p=document.querySelector(".mq-popover").getBoundingClientRect();return p.left>=0&&p.top>=0&&p.bottom<=innerHeight&&p.right<=innerWidth})()');
  if (shots) browser('screenshot', join(shots, 'quota-detail-dark.png'));
  evaluate('window.fixture.failRefresh=true'); browser('click', '.mq-popover .mq-button'); wait('document.querySelector("[role=alert]")');
  expect('document.querySelectorAll("[role=progressbar]").length === 2');
  evaluate('window.fixture.failRefresh=false'); snapshot(); browser('click', '.mq-popover .mq-button');
  wait('document.querySelector(".mq-chip:nth-child(2)").textContent.includes("92%") && document.querySelector(".mq-popover .mq-button").disabled');
  expect('window.fixture.writes === 2');
  browser('press', 'Escape'); wait(`!${dialog}`);
  expect('document.activeElement === document.querySelector(".mq-chip:nth-child(2)")');
  browser('press', 'Enter'); wait(dialog); snapshot(); browser('click', '.preview-header'); wait(`!${dialog}`);
  browser('set', 'media', 'light');
  if (shots) browser('screenshot', join(shots, 'quota-light.png'));
  // Full settings page shares the query and exposes every account.
  browser('click', '[aria-label="打开 Magpie 额度设置"]'); wait('document.querySelectorAll(".mq-card").length === 4'); snapshot();
  evaluate('window.fixture.scenario="error"'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelector(".mq-page").textContent.includes("此账号额度读取失败")');
  expect('document.querySelectorAll(".mq-card").length === 4 && document.querySelectorAll(".mq-card")[1].textContent.includes("暂无可用")');
  evaluate('window.fixture.scenario="stale"'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelector(".mq-page").textContent.includes("保留上次读数")');
  evaluate('window.fixture.scenario="forbidden"'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelectorAll(".mq-card").length === 0 && document.querySelector(".mq-page").textContent.includes("无权查看")');
  evaluate('window.fixture.scenario="many"'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelectorAll(".mq-card").length === 18');
  browser('click', 'button:text-is("＋ 新会话")'); wait(`${chips}.length === 18`); snapshot();
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth');
  browser('click', '.mq-chip:nth-child(1)'); wait(dialog); snapshot();
  expect('(()=>{const p=document.querySelector(".mq-popover").getBoundingClientRect();return p.left>=0&&p.top>=0&&p.bottom<=innerHeight&&p.right<=innerWidth})()');
  if (shots) browser('screenshot', join(shots, 'quota-mobile.png'));
  browser('set', 'viewport', '600', '300');
  wait('(()=>{const p=document.querySelector(".mq-popover").getBoundingClientRect();return p.top>=0&&p.bottom<=innerHeight})()');
  browser('press', 'Escape');
  browser('set', 'viewport', '1120', '780'); snapshot(); browser('click', '[aria-label="打开 Magpie 额度设置"]'); snapshot();
  evaluate('window.fixture.scenario="empty"'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelector(".mq-page").textContent.includes("未配置 Magpie")');
  browser('click', 'button:text-is("＋ 新会话")'); wait(`${chips}.length === 1`); browser('set', 'viewport', '390', '844'); snapshot();
  browser('click', '[aria-label="查看 Magpie 额度状态"]'); wait(dialog);
  expect('document.querySelector(".mq-popover").textContent.includes("请添加 Magpie")');
  // A failed first read must show a retry state, not claim no configuration exists.
  browser('open', `${base}?failRead=1`); browser('set', 'viewport', '1120', '780');
  wait('window.fixture.reads > 0 && document.querySelector(".mq-chip").textContent.includes("额度")'); snapshot(); browser('click', '[aria-label="打开 Magpie 额度设置"]');
  wait('document.querySelector("[role=alert]")');
  expect('document.querySelectorAll(".mq-card").length === 0 && !document.querySelector(".mq-page").textContent.includes("未配置 Magpie")');
  evaluate('window.fixture.failRead=false'); browser('click', 'button:text-is("重新读取")'); wait('document.querySelectorAll(".mq-card").length === 4');
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: compact account icons, actual slots, windows, refresh/errors/cooldown, keyboard/focus/outside dismissal, settings, permissions/stale/empty, many accounts, dark/light/mobile/short viewport');
} finally {
  try { browser('close'); } catch {}
  server.kill('SIGTERM'); if (server.exitCode === null && server.signalCode === null) await new Promise(resolve => server.once('exit', resolve));
}
