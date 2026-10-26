import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const session = `dsh-remote-ui-${process.pid}`;
const screenshots = process.env.DSH_REMOTE_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./preview.mjs', import.meta.url))], { env: { ...process.env, DSH_REMOTE_PREVIEW_PORT: '0', DSH_REMOTE_PREVIEW_TURN_MS: '4000' }, stdio: ['ignore', 'pipe', 'inherit'] });
function browser(...args) {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 * 3 }));
  if (!result.success) throw new Error(result.error ?? 'Browser command failed'); return result.data;
}
const evaluate = source => browser('eval', '-b', Buffer.from(source).toString('base64')).result;
const wait = source => {
  try { return browser('wait', '--fn', source); }
  catch (error) { throw new Error(`Timed out waiting for ${source}\nPage: ${String(evaluate('[...document.querySelectorAll("[data-connection]")].map(o=>o.dataset.connection).join(",") + "\\n" + (document.querySelector(".ra-main")?.innerText ?? document.body.innerText)')).slice(0, 1500)}`, { cause: error }); }
};
const expect = source => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${source}`); };
const state = () => evaluate('(async()=>await (await fetch("/__fixture")).json())()');
const fixture = data => evaluate(`(async()=>await fetch("/__fixture",{method:"POST",body:${JSON.stringify(JSON.stringify(data))}}))()`);
const chooseSsh = connection => {
  browser('click', '.ra-ssh-trigger'); wait('document.querySelector(".ra-ssh-menu:popover-open")');
  browser('click', `.ra-ssh-menu:popover-open [data-connection="${connection}"]`);
  wait('!document.querySelector(".ra-ssh-menu:popover-open")');
};
const image = name => { if (screenshots) browser('screenshot', ...(name.startsWith('sessions-') ? [] : ['--full']), `${screenshots}/${name}.png`); };
try {
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 20000);
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/local (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
  });
  browser('--executable-path', process.env.DSH_TEST_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'open', base);
  browser('set', 'viewport', '1440', '1000');

  // Settings remain available alongside the sidebar session entry.
  wait('document.querySelector(".dsh-ra input[aria-label=机器名称]")');
  expect('window.fixture.slots.length === 2 && window.fixture.slots[0] === "settings.section:remote-agents"');
  expect('!document.querySelector(".ra-launch,.ra-workspace,dialog")');
  expect('!document.querySelector(".ra-chat-projects,[aria-label=项目名称],[aria-label=远程项目路径]")');
  wait('document.querySelector(".ra-ssh-options [data-connection=\\"ssh://build-box\\"]")');
  browser('click', '.ra-ssh-trigger'); wait('document.querySelector(".ra-ssh-menu:popover-open")');
  expect('document.activeElement.getAttribute("aria-label") === "搜索 SSH 别名"');
  browser('set', 'media', 'dark'); image('ssh-dropdown-dark');
  expect('document.querySelector(".ra-ssh-menu:popover-open .ra-ssh-options").scrollHeight > document.querySelector(".ra-ssh-menu:popover-open .ra-ssh-options").clientHeight');
  browser('set', 'viewport', '390', '844');
  expect('(()=>{const r=document.querySelector(".ra-ssh-menu:popover-open").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()');
  browser('set', 'viewport', '1440', '1000');
  browser('fill', '[aria-label="搜索 SSH 别名"]', 'code-home');
  expect('document.querySelectorAll(".ra-ssh-menu:popover-open [role=option]").length === 2');
  browser('press', 'ArrowDown'); browser('press', 'Enter'); wait('!document.querySelector(".ra-ssh-menu:popover-open")');
  expect('document.querySelector("[aria-label=连接地址]").value === "ssh://code-home-233" && document.activeElement.classList.contains("ra-ssh-trigger")');
  browser('click', '.ra-ssh-trigger'); wait('document.querySelector(".ra-ssh-menu:popover-open")');
  browser('fill', '[aria-label="搜索 SSH 别名"]', 'no-such-alias'); browser('press', 'Enter');
  expect('document.querySelector(".ra-ssh-menu:popover-open").textContent.includes("没有匹配的 SSH 别名")');
  if (state().state.hosts.length) throw new Error('Enter in the alias search submitted the host form');
  browser('press', 'Escape'); wait('!document.querySelector(".ra-ssh-menu:popover-open")');
  fixture({ sshConfig: { hosts: [] } });
  browser('click', 'button:text-is("刷新 SSH 配置")'); wait('document.querySelector(".ra-ssh-config").textContent.includes("没有可选的具体主机别名")');
  fixture({ sshConfig: { hosts: [{ alias: 'build-box', connection: 'ssh://build-box' }, { alias: 'new-from-include', connection: 'ssh://new-from-include' }] } });
  browser('click', 'button:text-is("刷新 SSH 配置")'); wait('!document.querySelector(".ra-ssh-trigger").disabled');
  // Opening the picker clears the earlier search, so the refreshed alias is listed.
  browser('click', '.ra-ssh-trigger'); wait('document.querySelector(".ra-ssh-menu:popover-open [data-connection=\\"ssh://new-from-include\\"]")');
  browser('press', 'Escape'); wait('!document.querySelector(".ra-ssh-menu:popover-open")');
  chooseSsh('ssh://build-box');
  expect('document.querySelector("[aria-label=机器名称]").value === "build-box" && document.querySelector("[aria-label=连接地址]").value === "ssh://build-box"');
  if (state().state.hosts.length) throw new Error('Selecting an alias saved a host before submission');
  browser('click', 'button:text-is("保存机器")');

  wait('document.querySelector(".ra-hosts .ra-host-row strong")?.textContent === "build-box"');
  wait('document.querySelector(".ra-hosts .ra-host-row")?.textContent.includes("DSH 模型选择器中有 5 个模型")');
  browser('click', 'button:text-is("刷新模型")');
  wait('document.querySelector(".ra-hosts .ra-badge")?.textContent === "已连接"');
  console.log('PASS: settings and session slots, SSH alias keyboard selection, config refresh, host creation and connection');

  const groups = state().modelGroups;
  if (groups.map(g => g.name).join(',') !== 'Codex,DeepSeek Harness,Antigravity,Grok,CodeBuddy Code') throw new Error('CLI providers were not exposed as separate model picker groups');
  const machine = state().state.hosts[0];
  if (groups.some(g => g.models.some(m => !m.id.startsWith(machine.id + '/') || !m.name.includes('build-box')))) throw new Error('Models were not scoped and labelled by machine');
  if (state().tasks.length) throw new Error('Model discovery launched an agent');
  browser('set', 'media', 'light'); image('settings-light');
  browser('set', 'media', 'dark'); image('settings-dark');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth'); image('settings-mobile-dark');
  browser('set', 'media', 'light'); image('settings-mobile-light');
  browser('set', 'viewport', '1440', '1000');
  evaluate('window.fixture.setLocale("en")');
  wait('document.querySelector(".ra-hosts h2")?.textContent === "Hosts"');
  expect('document.querySelector(".ra-host-row").textContent.includes("5 models in the DSH picker")');
  image('settings-en');
  evaluate('window.fixture.setLocale("zh")');
  browser('open', `${base}?reloaded`);
  wait('document.querySelector(".ra-host-row")?.textContent.includes("DSH 模型选择器中有 5 个模型")');
  expect('!document.querySelector(".ra-chat-projects,[aria-label=项目名称],[aria-label=远程项目路径]")');
  browser('fill', '[aria-label="机器名称"]', 'Duplicate');
  browser('fill', '[aria-label="连接地址"]', 'ssh://build-box');
  browser('click', 'button:text-is("保存机器")');
  wait('document.querySelector(".ra-hosts [role=alert]")');
  if (state().state.hosts.length !== 1) throw new Error('A duplicate host was saved');
  browser('click', '.ra-hosts .ra-host-row button.ra-danger');
  wait('!document.querySelector(".ra-hosts .ra-host-row")');
  if (state().modelGroups.length) throw new Error('Removing a host left its models in the picker');
  console.log('PASS: machine-only model discovery, refresh, persistence, duplicate rejection and removal; no project registration; locales and responsive themes');

  fixture({ failReads: true }); browser('open', `${base}?offline`);
  wait('document.querySelector(".ra-settings [role=alert]")?.textContent.includes("模拟连接中断")');
  fixture({ failReads: false }); browser('click', 'button:text-is("重试")');
  wait('document.querySelector(".ra-hosts input[aria-label=机器名称]")');
  expect('window.fixture.slots.length === 2 && !document.querySelector(".ra-launch,.ra-workspace,dialog")');
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors.errors));
  console.log('PASS: settings load failure and retry; session entry available without opening a panel or adding a composer launcher');

  fixture({ seedSessions: true });
  wait('document.querySelector(".ra-attention-count")?.textContent === "1"');
  browser('click', '.ra-session-launch'); wait('document.querySelector("dialog[open] .ra-session-item")');
  expect('document.querySelectorAll(".ra-session-item").length === 3');
  browser('fill', '[aria-label="搜索会话"]', 'no-such-session');
  expect('document.querySelectorAll(".ra-session-item").length === 0');
  browser('fill', '[aria-label="搜索会话"]', '');
  browser('click', '.ra-filters button:text-is("待处理 (1)")');
  expect('document.querySelectorAll(".ra-session-item").length === 1');
  browser('click', '.ra-session-item'); wait('document.querySelector(".ra-permission")');
  browser('set', 'viewport', '390', '844');
  expect('document.querySelector("dialog").scrollWidth <= innerWidth');
  image('sessions-mobile-approval');
  browser('press', 'Escape'); wait('!document.querySelector("dialog[open]")');
  expect('document.activeElement.classList.contains("ra-session-launch")');
  if (state().answers.length || state().stops) throw new Error('Closing the panel resolved or stopped a pending approval');
  browser('click', '.ra-session-launch'); wait('document.querySelector("dialog[open] .ra-session-item")');
  browser('click', '.ra-session-item:has-text("审查构建脚本")'); wait('document.querySelector(".ra-permission")');
  browser('click', 'button:text-is("允许本次会话")');
  wait('!document.querySelector(".ra-permission") && document.querySelector(".ra-output")?.textContent.includes("审批已通过")');
  if (state().answers.at(-1)?.answer.selectedActionId !== 'session') throw new Error('Native session approval was not preserved');
  browser('click', 'button:text-is("返回会话列表")');
  expect('document.querySelector(".ra-session-list").getBoundingClientRect().width > 0');
  browser('set', 'viewport', '1440', '1000');
  browser('click', '.ra-session-item:has-text("整理项目测试")'); wait('document.querySelector(".ra-output button")?.textContent === "加载更早的消息"');
  expect('!document.querySelector(".ra-output").textContent.includes("最早的一条历史消息")');
  browser('click', 'button:text-is("加载更早的消息")');
  wait('document.querySelector(".ra-output").textContent.includes("最早的一条历史消息")');
  browser('fill', '[aria-label="给智能体发消息"]', '补充错误恢复测试');
  fixture({ loseSend: true }); browser('click', 'button:text-is("发送")');
  wait('document.querySelector(".ra-compose button")?.textContent === "检查送达情况" && !document.querySelector(".ra-compose button").disabled');
  browser('click', 'button:text-is("检查送达情况")');
  wait('document.querySelector(".ra-compose button")?.textContent === "发送" && document.querySelector(".ra-output").textContent.includes("已完成：补充错误恢复测试")');
  if (state().sends !== 1 || state().interrupts) throw new Error('A lost response resent or interrupted the task');
  browser('click', 'button:text-is("重命名")'); browser('fill', '[aria-label="会话标题"]', '恢复测试已完成'); browser('click', '.ra-rename button');
  wait('document.querySelector(".ra-detail-heading h2")?.textContent === "恢复测试已完成"');
  browser('set', 'media', 'dark'); image('sessions-dark');
  browser('set', 'media', 'light'); image('sessions-light');
  browser('click', 'button:text-is("归档")'); wait('document.querySelector(".ra-detail-heading .ra-badge")?.textContent === "已归档"');
  browser('click', '.ra-filters button:text-is("已归档")'); wait('document.querySelectorAll(".ra-session-item").length === 1');
  browser('click', 'button:text-is("恢复")'); wait('document.querySelectorAll(".ra-session-item").length === 0');
  browser('click', '.ra-filters button:text-is("全部会话")');
  browser('click', '.ra-session-item:has-text("实现搜索功能")'); wait('document.querySelector(".ra-compose-note")');
  expect('!document.querySelector("[aria-label=给智能体发消息]")');
  browser('click', 'button:text-is("在主对话打开")'); wait('!document.querySelector("dialog[open]")');
  expect('window.fixture.navigation.at(-1) === "fixture-main-chat"');
  browser('click', '.ra-session-launch'); wait('document.querySelector("dialog[open] .ra-list-heading")');
  browser('click', '.ra-list-heading button'); wait('document.querySelector("[aria-label=会话机器] option")');
  browser('fill', '[aria-label="任务"]', '检查 API 的分页实现');
  browser('click', 'button:text-is("开始会话")'); wait('document.querySelector(".ra-detail-heading h2")?.textContent === "检查 API 的分页实现"');
  if (state().creates !== 4) throw new Error('Starting a session did not create exactly one agent');
  if (state().tasks.at(-1).cwd !== '/srv/main-chat') throw new Error('The session did not use the current DSH workspace path');
  browser('set', 'viewport', '390', '844'); image('sessions-mobile-chat');
  expect('document.querySelector("dialog").scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".ra-compose textarea")?.getAttribute("aria-label") === "Message the agent"');
  browser('press', 'Escape'); wait('!document.querySelector("dialog[open]")');
  const sessionErrors = browser('errors'); if (sessionErrors.errors?.length) throw new Error(JSON.stringify(sessionErrors.errors));
  console.log('PASS: unified sessions, filters, native navigation, pagination, approval reopening and scope, lost-send recovery, rename/archive/restore, new sessions and mobile layouts');
} finally {
  try { browser('close'); } catch {}
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
