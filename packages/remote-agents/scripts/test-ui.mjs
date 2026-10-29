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
  // Return a boolean: some agent-browser versions cannot serialize a matched DOM element.
  try { return browser('wait', '--fn', `!!(${source})`); }
  catch (error) { throw new Error(`Timed out waiting for ${source}\nPage: ${String(evaluate('[...document.querySelectorAll("[data-connection]")].map(o=>o.dataset.connection).join(",") + "\\n" + (document.querySelector(".ra-main")?.innerText ?? document.body.innerText)')).slice(0, 1500)}`, { cause: error }); }
};
const expect = source => { if (!evaluate(source)) throw new Error(`UI assertion failed: ${source}${process.env.DSH_UI_DEBUG ? `\n${evaluate(process.env.DSH_UI_DEBUG)}` : ''}`); };
const state = () => evaluate('(async()=>await (await fetch("/__fixture")).json())()');
const fixture = data => evaluate(`(async()=>await fetch("/__fixture",{method:"POST",body:${JSON.stringify(JSON.stringify(data))}}))()`);
const chooseSsh = connection => {
  browser('click', '.ra-ssh-trigger'); wait('document.querySelector(".ra-ssh-menu:popover-open")');
  browser('click', `.ra-ssh-menu:popover-open [data-connection="${connection}"]`);
  wait('!document.querySelector(".ra-ssh-menu:popover-open")');
};
const image = name => { if (screenshots) browser('screenshot', ...(name.startsWith('sessions-') || name.startsWith('model-groups-') ? [] : ['--full']), `${screenshots}/${name}.png`); };
const workspaceChecks = () => {
  evaluate('window.fixture.setLocale("en")');
  const entries = '.ra-ws-entries', viewing = '.ra-ws-viewer-head .ra-mono', editor = '[aria-label="Remote file contents"]';
  // The CodeMirror editor's text, line by line; undefined while no editor is shown.
  const editorText = `(document.querySelector('${editor}') ? [...document.querySelectorAll('${editor} .cm-line')].map(line => line.textContent).join("\\n") : undefined)`;
  browser('click', '[data-open-workspace]'); wait(`document.querySelector("${entries}")?.textContent.includes("hello.txt")`);
  expect('document.querySelector(".ra-ws-target")?.title === "build-box:/srv/main-chat"');
  expect('[...document.querySelectorAll(".ra-ws-tabs button")].map(b => b.textContent).join() === "Files,Sync,Tunnels,Remote DSH"');
  browser('click', `${entries} button:has-text("hello.txt")`);
  wait(`${editorText}?.includes("Hello from")`);
  // ⌘/Ctrl+S saves from the editor.
  browser('fill', editor, 'edited from the workspace UI'); wait('document.querySelector(".ra-ws-dirty")');
  browser('press', 'Control+s'); wait('!document.querySelector(".ra-ws-dirty") && !document.querySelector(".ra-ws-busy") && document.querySelector(".ra-ws-viewer-actions .ra-primary")?.disabled');
  fixture({ workspaceContent: 'external change' });
  browser('fill', editor, 'stale edit'); browser('click', 'button:text-is("Save to remote")');
  wait('document.querySelector(".ra-workspace-panel [role=alert]")?.textContent.includes("file changed")');
  browser('click', 'button:text-is("Reload file")'); wait(`${editorText} === "external change"`);
  // A new file opens right away; a folder does not.
  const create = (kind, name) => {
    browser('click', '[aria-label="New file or folder"]'); browser('click', `.ra-ws-inline [role=radio]:text-is("${kind}")`);
    browser('fill', '[aria-label="New item name"]', name); browser('click', 'button:text-is("Create")');
  };
  create('File', 'created.txt'); wait(`document.querySelector("${viewing}")?.textContent === "created.txt" && ${editorText} === ""`);
  browser('fill', '[aria-label="Rename destination"]', 'renamed.txt'); browser('click', '.ra-ws-rename button'); wait(`document.querySelector("${viewing}")?.textContent === "renamed.txt"`);
  // Unsaved edits block opening another file, not browsing folders; closing asks to save or discard first.
  create('Folder', 'docs'); wait(`document.querySelector("${entries}")?.textContent.includes("docs")`);
  browser('fill', editor, 'unsaved'); browser('click', `${entries} button:text-is("docs")`);
  wait(`[...document.querySelectorAll(".ra-ws-crumbs button")].some(b => b.textContent === "docs") && ${editorText} === "unsaved"`);
  browser('click', '.ra-ws-crumbs button'); wait(`document.querySelector("${entries}")?.textContent.includes("hello.txt")`);
  browser('click', `${entries} button:has-text("hello.txt")`); wait('document.querySelector(".ra-workspace-panel [role=alert]")?.textContent.includes("Save or discard")');
  expect(`document.querySelector("${viewing}")?.textContent === "renamed.txt"`);
  browser('click', '[aria-label="Close file"]'); expect(`document.querySelector("${viewing}")?.textContent === "renamed.txt"`);
  browser('click', 'button:text-is("Discard changes")'); browser('click', '[aria-label="Close file"]'); wait(`document.querySelector(".ra-ws-placeholder") && !document.querySelector('${editor}')`);
  browser('click', `${entries} button:has-text("renamed.txt")`); wait(`document.querySelector("${viewing}")?.textContent === "renamed.txt"`);
  browser('click', 'button:text-is("Delete file")'); browser('click', 'button:text-is("Delete")'); wait(`!document.querySelector("${entries}")?.textContent.includes("renamed.txt")`);
  evaluate('(()=>{const input=document.querySelector(".ra-ws-files input[type=file]"), files=new DataTransfer();files.items.add(new File([new Uint8Array([0,1,255])],"upload.bin"));input.files=files.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
  wait(`document.querySelector("${entries}")?.textContent.includes("upload.bin")`);
  // An uploaded image is shown instead of the binary-file note.
  evaluate('(()=>{const input=document.querySelector(".ra-ws-files input[type=file]"), files=new DataTransfer();files.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),c=>c.charCodeAt(0))],"pixel.png"));input.files=files.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
  wait(`document.querySelector("${entries}")?.textContent.includes("pixel.png")`);
  browser('click', `${entries} button:has-text("pixel.png")`);
  wait('document.querySelector(".ra-ws-preview .fv-image img")?.naturalWidth === 1 && !document.querySelector(".ra-ws-viewer .ra-ws-note")');
  wait('document.querySelector(".fv-image-meta")?.textContent.startsWith("1 × 1")');
  browser('click', 'button:text-is("Delete file")'); browser('click', 'button:text-is("Delete")'); wait(`!document.querySelector("${entries}")?.textContent.includes("pixel.png")`);
  // A binary file cannot be edited here, but it can still be renamed and deleted.
  browser('click', `${entries} button:has-text("upload.bin")`);
  wait(`document.querySelector(".ra-ws-viewer .ra-ws-note")?.textContent.includes("binary") && !document.querySelector('${editor}')`);
  browser('fill', '[aria-label="Rename destination"]', 'moved.bin'); browser('click', '.ra-ws-rename button');
  wait(`document.querySelector("${viewing}")?.textContent === "moved.bin" && document.querySelector("${entries}")?.textContent.includes("moved.bin")`);
  browser('click', 'button:text-is("Delete file")'); browser('click', 'button:text-is("Delete")'); wait(`!document.querySelector("${entries}")?.textContent.includes("moved.bin")`);
  // Search runs on Enter; the clear button and Escape end it without closing the window.
  const search = () => { browser('fill', '[aria-label="Search remote files"]', 'external'); browser('press', 'Enter'); wait(`document.querySelector("${entries} small")?.textContent === "1: external change"`); };
  const searchCleared = `document.querySelector('[aria-label="Search remote files"]').value === "" && document.querySelector("${entries}")?.textContent.includes("docs")`;
  search(); browser('click', '[aria-label="Clear search"]'); wait(searchCleared);
  search(); browser('press', 'Escape'); wait(searchCleared); expect('document.querySelector("dialog[open]")');
  browser('set', 'viewport', '390', '844'); expect('document.querySelector("dialog").scrollWidth <= innerWidth'); image('workspace-files-mobile'); browser('set', 'viewport', '1440', '1000');
  const syncTitle = '.ra-ws-section [role=status]';
  browser('click', '.ra-ws-tabs button:text-is("Sync")'); browser('click', 'button:text-is("Preview sync")'); wait(`document.querySelector("${syncTitle}")?.textContent.startsWith("Sync preview")`);
  browser('click', 'button:text-is("Apply preview")'); wait(`document.querySelector("${syncTitle}")?.textContent.startsWith("Sync completed")`);
  // A preview without changes is applied too, recording the baseline for identical files.
  browser('click', 'button:text-is("Preview sync")'); wait(`document.querySelector("${syncTitle}")?.textContent === "Sync preview0 changes · 0 conflicts"`);
  browser('click', 'button:text-is("Apply preview")'); wait(`document.querySelector("${syncTitle}")?.textContent === "Sync completed0 changes · 0 conflicts"`);
  // Add and start saves a tunnel and runs it.
  const tunnel = '.ra-ws-tunnels li', status = value => `document.querySelector("${tunnel}")?.dataset.status === "${value}"`;
  browser('click', '.ra-ws-tabs button:text-is("Tunnels")'); browser('click', 'button:text-is("Add and start")');
  wait(`${status('running')} && document.querySelector("${tunnel} a")?.href === "http://" + location.hostname + ":38080/"`);
  browser('click', `${tunnel} [aria-label="Stop"]`); wait(status('stopped'));
  browser('click', `${tunnel} [aria-label="Remove"]`); wait(`!document.querySelector("${tunnel}")`);
  const webLink = '.ra-ws-section a.ra-ws-button';
  browser('click', '.ra-ws-tabs button:text-is("Remote DSH")'); browser('fill', '[aria-label="Remote login URL"]', 'http://127.0.0.1:3080/?token=test-only'); browser('click', 'button:text-is("Connect remote DSH")');
  wait(`document.querySelector("${webLink}")?.href === "http://" + location.hostname + ":38088/?token=test-only"`);
  // Connecting again reuses the saved tunnel, whether it is still running or was stopped.
  const reconnect = token => {
    browser('fill', '[aria-label="Remote login URL"]', `http://127.0.0.1:3080/?token=${token}`); wait(`!document.querySelector("${webLink}")`);
    browser('click', 'button:text-is("Connect remote DSH")'); wait(`document.querySelector("${webLink}")?.href === "http://" + location.hostname + ":38088/?token=${token}"`);
    expect('!document.querySelector(".ra-workspace-panel [role=alert]")');
  };
  reconnect('running');
  browser('click', '.ra-ws-tabs button:text-is("Tunnels")'); wait(status('running'));
  browser('click', `${tunnel} [aria-label="Stop"]`); wait(status('stopped'));
  browser('click', '.ra-ws-tabs button:text-is("Remote DSH")'); reconnect('stopped');
  browser('click', '.ra-ws-tabs button:text-is("Tunnels")'); wait(status('running'));
  expect(`document.querySelectorAll("${tunnel}").length === 1`);
  browser('click', `${tunnel} [aria-label="Remove"]`); wait(`!document.querySelector("${tunnel}")`);
  browser('press', 'Escape'); wait('!document.querySelector("dialog[open]")'); evaluate('window.fixture.setLocale("zh")');
  console.log('PASS: integrated workspace files, Ctrl+S, stale-edit conflicts, create/rename/close/delete, folders with unsaved edits, upload, search and clear, sync preview/apply, tunnels, remote DSH attach and mobile layout');
};
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

  if (process.argv.includes('--workspace-only')) {
    wait('window.fixture'); fixture({ seedSessions: true }); workspaceChecks();
  } else {

  if (!process.argv.includes('--custom-labels-only')) {
  if (!process.argv.includes('--models-only')) {
  // Remote sessions are available only from settings.
  wait('document.querySelector(".dsh-ra input[aria-label=机器名称]")');
  expect('window.fixture.slots.join() === "settings.section:remote-agents,conversation.input.model.label:remote-agents-model-label,conversation.input.right:remote-agents-usage,conversation.input.left:remote-agents-fast,conversation.hero.workspace.directoryFlow:remote-agents-workspace-flow,sidebar.workspaces.directoryFlow:remote-agents-workspace-flow"');
  expect('!document.querySelector(".ra-launch,.ra-workspace,.ra-session-launch,dialog")');
  // Add workspace: this plugin shadows DSH's own picker. Without saved machines the OS chooser opens directly.
  const openFlow = () => { wait('document.querySelector("[data-flow-open=false]")'); browser('click', '[data-open-flow]'); };
  expect('window.fixture.flow.owner === "remote-agents"');
  openFlow(); wait('window.fixture.flow.picked.length === 1');
  expect('window.fixture.flow.picked[0] === "/Users/me/project" && window.fixture.flow.picks === 1 && !document.querySelector(".ra-flow")');
  evaluate('window.fixture.flow.localPick = null');
  openFlow(); wait('window.fixture.flow.cancelled === 1');
  expect('window.fixture.flow.picks === 2 && !document.querySelector(".ra-flow") && !window.fixture.flow.errors.length');
  evaluate('window.fixture.flow.localPick = "/Users/me/project"');
  console.log('PASS: Add workspace without saved machines behaves as the native picker');
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
  expect('document.querySelectorAll(".ra-host-form .ra-cli-options input:checked").length === 0');
  browser('check', '.ra-host-form .ra-cli-options input[value="codex"]');
  browser('click', 'button:text-is("保存机器")');

  wait('document.querySelector(".ra-hosts .ra-host-row strong")?.textContent === "build-box"');
  wait('document.querySelector(".ra-hosts .ra-host-row")?.textContent.includes("DSH 模型选择器中有 1 个模型")');
  browser('click', 'button:text-is("刷新模型")');
  wait('document.querySelector(".ra-hosts .ra-badge")?.textContent === "已连接"');
  console.log('PASS: settings-only session entry, SSH alias keyboard selection, config refresh, host creation and connection');

  // With a saved machine, Add workspace offers this computer or the machine.
  const flowPath = 'document.querySelector(".ra-flow input[aria-label=文件夹路径]")?.value';
  const flowEntries = '[...document.querySelectorAll(".ra-flow-entry")].map(e => e.textContent).sort().join()';
  openFlow(); wait('document.querySelector("dialog.ra-flow[open]")');
  expect('document.querySelector(".ra-flow [role=tab][aria-selected=true]").textContent === "本机"');
  browser('click', '.ra-flow button:text-is("选择文件夹…")');
  wait('window.fixture.flow.picked.length === 2'); wait('!document.querySelector("dialog.ra-flow")');
  expect('window.fixture.flow.picked[1] === "/Users/me/project"');
  openFlow(); wait('document.querySelector("dialog.ra-flow[open]")');
  browser('click', '.ra-flow [role=tab]:text-is("远程机器")');
  wait(`${flowPath} === "/home/builder"`);
  expect(`${flowEntries} === "app,notes"`);
  browser('check', '.ra-flow-foot input[type=checkbox]');
  expect(`${flowEntries} === ".config,app,notes"`);
  browser('uncheck', '.ra-flow-foot input[type=checkbox]');
  expect('document.querySelector(".ra-flow .ra-foot").textContent.includes("build-box")');
  browser('set', 'media', 'light'); image('workspace-flow-light');
  browser('set', 'media', 'dark'); image('workspace-flow-dark');
  browser('click', '.ra-flow-entry >> text="app"');
  wait(`${flowPath} === "/home/builder/app"`); wait('document.querySelector(".ra-flow-note")?.textContent === "没有子文件夹"');
  browser('click', '.ra-flow button:text-is("使用此文件夹")');
  wait('window.fixture.flow.picked.length === 3'); wait('!document.querySelector("dialog.ra-flow")');
  expect('window.fixture.flow.picked[2].endsWith("/remote-workspaces/build-box-builder-22/app")');
  // Reopening restores the tab and the machine's last folder. Failures stay in the dialog; Escape cancels.
  openFlow(); wait('document.querySelector("dialog.ra-flow[open]")');
  wait(`${flowPath} === "/home/builder/app"`);
  expect('document.querySelector(".ra-flow [role=tab][aria-selected=true]").textContent === "远程机器"');
  // Only a folder that was listed successfully, and is still shown in the path field, can be added.
  const useFolder = 'document.querySelector(".ra-flow-foot .ra-primary")';
  expect(`!${useFolder}.disabled`);
  browser('fill', '.ra-flow input[aria-label=文件夹路径]', '/home/builder/notes');
  expect(`${useFolder}.disabled`);
  browser('fill', '.ra-flow input[aria-label=文件夹路径]', '/srv/missing'); browser('press', 'Enter');
  wait('document.querySelector(".ra-flow [role=alert]")?.textContent === "该路径不是可读取的目录"');
  expect(`${useFolder}.disabled`);
  browser('click', '.ra-flow button[aria-label=上一级]');
  wait(`${flowPath} === "/home/builder"`); expect(`!document.querySelector(".ra-flow [role=alert]") && !${useFolder}.disabled`);
  browser('set', 'viewport', '390', '844');
  expect('(()=>{const r=document.querySelector("dialog.ra-flow").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.querySelector("dialog.ra-flow").scrollWidth<=r.width})()');
  image('workspace-flow-mobile');
  browser('set', 'viewport', '1440', '1000');
  browser('press', 'Escape'); wait('!document.querySelector("dialog.ra-flow")');
  expect('window.fixture.flow.cancelled === 2 && window.fixture.flow.picked.length === 3');
  // A browse composition refuses the OS chooser: this computer is listed inside the dialog instead.
  evaluate('window.fixture.flow.refusePick = true');
  openFlow(); wait('document.querySelector("dialog.ra-flow[open]")');
  browser('click', '.ra-flow [role=tab]:text-is("本机")');
  browser('click', '.ra-flow button:text-is("选择文件夹…")');
  wait(`${flowPath} === "/Users/me"`); expect(`${flowEntries} === "notes,project"`);
  browser('click', '.ra-flow-entry >> text="notes"'); wait(`${flowPath} === "/Users/me/notes"`);
  browser('click', '.ra-flow button[aria-label=上一级]'); wait(`${flowPath} === "/Users/me"`);
  browser('click', '.ra-flow button:text-is("使用此文件夹")');
  wait('window.fixture.flow.picked.length === 4'); wait('!document.querySelector("dialog.ra-flow")');
  expect('window.fixture.flow.picked[3] === "/Users/me" && !window.fixture.flow.errors.length');
  evaluate('window.fixture.flow.refusePick = false');
  // Closing while a folder is being added cancels it: the late response reports nothing.
  fixture({ createDelay: 1500 });
  openFlow(); wait('document.querySelector("dialog.ra-flow[open]")');
  browser('click', '.ra-flow [role=tab]:text-is("远程机器")'); wait(`${flowPath} === "/home/builder/app"`);
  browser('click', '.ra-flow button:text-is("使用此文件夹")'); wait(`${useFolder}.textContent === "正在打开…"`);
  browser('click', '.ra-flow button[aria-label=关闭]'); wait('!document.querySelector("dialog.ra-flow")');
  evaluate('(async()=>{await new Promise(resolve => setTimeout(resolve, 2500));return true})()');
  expect('window.fixture.flow.picked.length === 4 && window.fixture.flow.cancelled === 3 && !window.fixture.flow.errors.length');
  fixture({ createDelay: 0 });
  console.log('PASS: Add workspace with saved machines: this computer, remote browsing and adoption, remembered folder, unconfirmed and failed folders, cancel, cancelled adoption and browse fallback');

  const groups = state().modelGroups;
  if (groups.map(g => g.name).join(',') !== 'Codex') throw new Error('CLI providers were not exposed as separate model picker groups');
  const machine = state().state.hosts[0];
  if (groups.some(g => g.models.some(m => !m.id.startsWith(machine.id + '/') || !m.name.includes('build-box')))) throw new Error('Models were not scoped and labelled by machine');
  if (state().tasks.length) throw new Error('Model discovery launched an agent');
  browser('check', '.ra-host-row .ra-cli-options input[value="codebuddy"]');
  browser('click', '.ra-host-row button:text-is("应用选择")');
  wait('document.querySelector(".ra-host-row").textContent.includes("DSH 模型选择器中有 2 个模型")');
  if (state().modelGroups.map(g => g.name).join(',') !== 'Codex,CodeBuddy Code') throw new Error('Enabling a CLI did not add its models');
  browser('uncheck', '.ra-host-row .ra-cli-options input[value="codebuddy"]');
  browser('click', '.ra-host-row button:text-is("应用选择")');
  wait('document.querySelector(".ra-host-row").textContent.includes("DSH 模型选择器中有 1 个模型")');
  if (state().modelGroups.map(g => g.name).join(',') !== 'Codex') throw new Error('A disabled CLI remained in the model picker');

  browser('set', 'media', 'light'); image('settings-light');
  browser('set', 'media', 'dark'); image('settings-dark');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth'); image('settings-mobile-dark');
  browser('set', 'media', 'light'); image('settings-mobile-light');
  browser('set', 'viewport', '1440', '1000');
  evaluate('window.fixture.setLocale("en")');
  wait('document.querySelector(".ra-hosts h2")?.textContent === "Hosts"');
  expect('document.querySelector(".ra-host-row").textContent.includes("1 models in the DSH picker")');
  image('settings-en');
  evaluate('window.fixture.setLocale("zh")');
  browser('open', `${base}?reloaded`);
  wait('document.querySelector(".ra-host-row")?.textContent.includes("DSH 模型选择器中有 1 个模型")');
  expect('!document.querySelector(".ra-chat-projects,[aria-label=项目名称],[aria-label=远程项目路径]")');
  expect('document.querySelectorAll(".ra-host-row .ra-cli-options input:checked").length === 1 && document.querySelector(".ra-host-row .ra-cli-options input[value=codex]").checked');
  browser('fill', '[aria-label="机器名称"]', 'Duplicate');
  browser('fill', '[aria-label="连接地址"]', 'ssh://build-box');
  browser('click', 'button:text-is("保存机器")');
  wait('document.querySelector(".ra-hosts [role=alert]")');
  if (state().state.hosts.length !== 1) throw new Error('A duplicate host was saved');
  browser('click', '.ra-hosts .ra-host-row button.ra-danger');
  wait('!document.querySelector(".ra-hosts .ra-host-row")');
  if (state().modelGroups.length) throw new Error('Removing a host left its models in the picker');
  console.log('PASS: selected-CLI discovery, enable/disable, persistence, refresh, duplicate rejection and removal; no project registration; locales and responsive themes');

  fixture({ failReads: true }); browser('open', `${base}?offline`);
  wait('document.querySelector(".ra-settings [role=alert]")?.textContent.includes("模拟连接中断")');
  fixture({ failReads: false }); browser('click', 'button:text-is("重试")');
  wait('document.querySelector(".ra-hosts input[aria-label=机器名称]")');
  expect('window.fixture.slots.length === 6 && !document.querySelector(".ra-launch,.ra-workspace,.ra-session-launch,dialog")');
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors.errors));
  console.log('PASS: settings load failure and retry; session entry remains in settings without a sidebar or composer launcher');

  fixture({ seedSessions: true });
  workspaceChecks();
  browser('click', '[data-open-sessions]'); wait('document.querySelector("dialog[open] .ra-session-item")');
  expect('document.querySelectorAll(".ra-session-item").length === 1');
  image('sessions-overview');
  browser('fill', '[aria-label="搜索会话"]', 'no-such-session');
  expect('document.querySelectorAll(".ra-session-item").length === 0');
  browser('fill', '[aria-label="搜索会话"]', '');
  expect('document.querySelectorAll(".ra-session-item").length === 1');
  browser('click', '.ra-session-item'); wait('document.querySelector(".ra-permission")');
  browser('click', 'button[aria-label="会话选项"]');
  expect('document.querySelector("[aria-label=权限模式]").disabled');
  browser('click', 'button[aria-label="会话选项"]');
  browser('set', 'viewport', '390', '844');
  expect('document.querySelector("dialog").scrollWidth <= innerWidth');
  image('sessions-mobile-approval');
  browser('press', 'Escape'); wait('!document.querySelector("dialog[open]")');
  expect('document.activeElement === document.querySelector("[data-open-sessions]")');
  if (state().answers.length || state().stops) throw new Error('Closing the panel resolved or stopped a pending approval');
  browser('click', '[data-open-sessions]'); wait('document.querySelector("dialog[open] .ra-session-item")');
  browser('click', '.ra-session-item:has-text("审查构建脚本")'); wait('document.querySelector(".ra-permission")');
  browser('click', 'button:text-is("此项目始终允许匹配的请求")');
  wait('!document.querySelector(".ra-permission") && document.querySelector(".ra-output")?.textContent.includes("审批已通过")');
  if (state().answers.at(-1)?.answer.selectedActionId !== 'project') throw new Error('Native project approval was not preserved');
  // A persistent session that lost SSH keeps its state and says it is reconnecting.
  fixture({ relayState: true });
  wait('document.querySelector(".ra-detail-heading .ra-badge")?.textContent === "正在重连" && document.querySelector(".ra-detail-heading").textContent.includes("SSH 连接已断开")');
  image('sessions-reconnecting');
  browser('click', 'button:text-is("返回会话列表")');
  expect('document.querySelector(".ra-session-list").getBoundingClientRect().width > 0');
  browser('click', '.ra-filters button:has-text("历史记录")');
  wait('[...document.querySelectorAll(".ra-session-item")].some(item => item.textContent.includes("审查构建脚本") && item.textContent.includes("正在重连"))');
  browser('set', 'viewport', '1440', '1000');
  browser('click', '.ra-session-item:has-text("整理项目测试")'); wait('document.querySelector(".ra-output button")?.textContent === "加载更早的消息"');
  browser('click', 'button[aria-label="会话选项"]');
  browser('select', '[aria-label="权限模式"]', 'full-access');
  wait('document.querySelector("[aria-label=权限模式]")?.value === "full-access" && !document.querySelector("[aria-label=权限模式]").disabled');
  if (state().tasks.find(t => t.title === '整理项目测试').modeId !== 'full-access') throw new Error('The session permission mode was not saved');
  browser('select', '[aria-label="权限模式"]', 'ask');
  wait('document.querySelector("[aria-label=权限模式]")?.value === "ask" && !document.querySelector("[aria-label=权限模式]").disabled');
  browser('click', 'button[aria-label="会话选项"]');
  expect('!document.querySelector(".ra-output").textContent.includes("最早的一条历史消息")');
  browser('click', 'button:text-is("加载更早的消息")');
  wait('document.querySelector(".ra-output").textContent.includes("最早的一条历史消息")');
  browser('fill', '[aria-label="给智能体发消息"]', '补充错误恢复测试');
  fixture({ loseSend: true }); browser('click', 'button:text-is("发送")');
  wait('document.querySelector(".ra-compose button")?.textContent === "检查送达情况" && !document.querySelector(".ra-compose button").disabled');
  browser('click', 'button:text-is("检查送达情况")');
  wait('document.querySelector(".ra-compose button")?.textContent === "发送" && document.querySelector(".ra-output").textContent.includes("已完成：补充错误恢复测试")');
  if (state().sends !== 1 || state().interrupts) throw new Error('A lost response resent or interrupted the task');
  browser('click', 'button[aria-label="会话选项"]');
  browser('click', 'button:text-is("重命名")'); browser('fill', '[aria-label="会话标题"]', '恢复测试已完成'); browser('click', '.ra-rename button');
  wait('document.querySelector(".ra-detail-heading h2")?.textContent === "恢复测试已完成"');
  browser('set', 'media', 'dark'); image('sessions-dark');
  browser('set', 'media', 'light'); image('sessions-light');
  browser('click', 'button:text-is("归档")'); wait('document.querySelector(".ra-detail-actions")?.textContent.includes("恢复")');
  browser('click', '.ra-archive-link'); wait('document.querySelectorAll(".ra-session-item").length === 1');
  browser('click', 'button:text-is("恢复")'); wait('document.querySelectorAll(".ra-session-item").length === 0');
  browser('click', '.ra-filters button:has-text("历史记录")');
  browser('click', '.ra-session-item:has-text("实现搜索功能")'); wait('document.querySelector(".ra-compose-note")');
  expect('!document.querySelector("[aria-label=给智能体发消息]")');
  browser('click', 'button:text-is("在主对话打开")'); wait('!document.querySelector("dialog[open]")');
  expect('window.fixture.navigation.at(-1) === "fixture-main-chat"');
  browser('click', '[data-open-sessions]'); wait('document.querySelector("dialog[open] .ra-list-heading")');
  browser('click', '.ra-list-heading button'); wait('document.querySelector("[aria-label=会话机器] option")');
  expect('document.querySelector(".ra-new-session .ra-mono").textContent === "/srv/main-chat" && !document.querySelector(".ra-new-session").textContent.includes("/fixture/remote-workspaces")');
  expect('document.querySelectorAll("[aria-label=会话机器] option").length === 1 && document.querySelector("[aria-label=会话机器] option").textContent === "build-box"');
  browser('select', '[aria-label="权限模式"]', 'full-access');
  browser('fill', '[aria-label="任务"]', '检查 API 的分页实现');
  browser('click', 'button:text-is("开始会话")'); wait('document.querySelector(".ra-detail-heading h2")?.textContent === "检查 API 的分页实现"');
  if (state().creates !== 4) throw new Error('Starting a session did not create exactly one agent');
  if (state().tasks.at(-1).cwd !== '/srv/main-chat') throw new Error('The session did not use the current DSH workspace path');
  if (state().tasks.at(-1).modeId !== 'full-access') throw new Error('The new session did not use the selected permission mode');
  browser('set', 'viewport', '390', '844'); image('sessions-mobile-chat');
  expect('document.querySelector("dialog").scrollWidth <= innerWidth');
  evaluate('window.fixture.setLocale("en")'); wait('document.querySelector(".ra-compose textarea")?.getAttribute("aria-label") === "Message the agent"');
  browser('press', 'Escape'); wait('!document.querySelector("dialog[open]")');
  const sessionErrors = browser('errors'); if (sessionErrors.errors?.length) throw new Error(JSON.stringify(sessionErrors.errors));
  console.log('PASS: unified sessions, filters, native navigation, pagination, approval reopening and scope, lost-send recovery, rename/archive/restore, new sessions and mobile layouts');

  // An SSH failure must not trap hosts behind undeletable saved sessions.
  evaluate('window.fixture.setLocale("zh")');
  const saved = state().state.agents;
  evaluate(`(async()=>await fetch('/api/remote-agents',{method:'POST',headers:{'content-type':'application/json','X-DSH-Remote-Agents':'1'},body:JSON.stringify({action:'archive',agentId:${JSON.stringify(saved[0].id)}})}))()`);
  fixture({ connectionError: 'ssh: Could not resolve hostname ubuntu-claude-103: nodename nor servname provided, or not known' });
  browser('open', `${base}?offline-removal`);
  wait('document.querySelector(".ra-host-row")');
  browser('click', '.ra-host-row button:text-is("刷新模型")');
  wait('document.querySelector(".ra-host-error")?.textContent.includes("Could not resolve hostname")');
  expect('!document.querySelector(".ra-host-top button.ra-danger").disabled');
  browser('click', '.ra-host-top button.ra-danger');
  wait('document.querySelector(".ra-remove-confirm")');
  expect(`document.querySelector('.ra-remove-confirm').textContent.includes('${saved.length} 个已保存会话') && document.querySelector('.ra-remove-confirm').textContent.includes('包括已归档会话')`);
  if (state().state.agents.length !== saved.length) throw new Error('Opening removal confirmation deleted sessions');
  browser('set', 'viewport', '390', '844');
  expect('document.documentElement.scrollWidth <= innerWidth'); image('host-removal-offline-mobile');
  browser('click', '.ra-remove-confirm button:text-is("取消")');
  wait('!document.querySelector(".ra-remove-confirm")');
  if (state().state.agents.length !== saved.length) throw new Error('Cancelling removal deleted sessions');
  browser('click', '.ra-host-top button.ra-danger');
  browser('click', '.ra-remove-confirm button:text-is("移除机器并删除会话")');
  wait('!document.querySelector(".ra-host-row")');
  const removed = state();
  if (removed.state.hosts.length || removed.state.agents.length || removed.tasks.length || removed.modelGroups.length) throw new Error('Offline removal left host sessions or models behind');
  fixture({ connectionError: '' });
  browser('set', 'viewport', '1440', '1000');
  console.log('PASS: offline host removal with active/archived sessions, explicit confirmation, cancellation and model cleanup');

  }
  const trigger = '[data-native-picker] button';
  const menu = '[data-menu-material]';
  const rootModel = `${menu} > button:first-of-type`;
  const group = provider => `[data-model-group="${provider}"]`;
  const heading = provider => `${group(provider)} > [data-menu-group-heading]`;
  const visible = '[data-model-group-option]:not([data-model-group-hidden])';
  browser('set', 'viewport', '1440', '1000');
  wait('document.querySelector("[data-native-picker] button")');
  expect('window.fixture.slots.length === 6');
  browser('click', trigger); wait('document.querySelector("[data-menu-material] > button")');
  image('model-groups-native-root');
  browser('click', rootModel); wait('document.querySelector("[data-model-group]")');
  expect('document.querySelectorAll("[data-model-group]").length === 4');
  expect('document.querySelector("[data-model-group=remote-cli-codex] [data-menu-group-heading]").getAttribute("aria-expanded") === "true"');
  expect('document.querySelector("[data-model-group=remote-cli-codebuddy] [data-menu-group-heading]").getAttribute("aria-expanded") === "false"');
  browser('click', heading('remote-cli-codebuddy'));
  expect('document.querySelectorAll("[data-model-group=remote-cli-codebuddy] [data-model-group-option]:not([data-model-group-hidden])").length === 24');
  browser('set', 'media', 'dark'); image('model-groups-expanded-dark');
  browser('click', heading('remote-cli-codebuddy'));
  expect('document.querySelectorAll("[data-model-group=remote-cli-codebuddy] [data-model-group-option]:not([data-model-group-hidden])").length === 0');
  browser('set', 'media', 'light'); image('model-groups-collapsed-light');
  browser('fill', `${menu} input`, 'Balanced');
  expect('document.querySelectorAll("[data-model-group-option]:not([data-model-group-hidden])").length === 1');
  expect('document.querySelector("[data-menu-group-heading]").getAttribute("aria-expanded") === "true"');
  browser('fill', `${menu} input`, '');
  expect('document.querySelectorAll("[data-model-group=remote-cli-codebuddy] [data-model-group-option]:not([data-model-group-hidden])").length === 0');
  browser('fill', `${menu} input`, 'Balanced'); browser('press', 'Enter');
  wait('!document.querySelector("[data-menu-material]") && document.querySelector("[data-native-picker] button").textContent.includes("Balanced")');
  expect('window.fixture.picker.selections.at(-1).provider === "remote-cli-codebuddy" && window.fixture.picker.selections.at(-1).model === "macmini/codebuddy/buddy-2"');
  expect('document.activeElement.closest("[data-native-picker]") !== null');
  browser('click', trigger); browser('click', rootModel); wait('document.querySelector("[data-model-group]")');
  expect('document.querySelectorAll("[data-model-group-option]:not([data-model-group-hidden])").length === 0');
  // Enter must never accept the native picker's highlighted but folded-away option.
  const beforeHidden = evaluate('window.fixture.picker.selections.length'); browser('press', 'Enter');
  expect(`window.fixture.picker.selections.length === ${beforeHidden}`);
  browser('press', 'ArrowDown');
  expect('document.activeElement.hasAttribute("data-menu-group-heading")');
  browser('press', 'ArrowRight'); browser('press', 'ArrowDown');
  expect('document.activeElement.querySelector("[data-provider-id=deepseek-account]") !== null');
  browser('press', 'Enter'); wait('!document.querySelector("[data-menu-material]")');
  expect('window.fixture.picker.selections.at(-1).provider === "deepseek-account"');
  evaluate('window.fixture.picker.current({provider:"remote-cli-codex",model:"macmini/codex/codex-model",reasoningEffort:"medium"})');
  browser('click', trigger); wait('document.querySelectorAll("[data-menu-material] > button").length === 2');
  browser('click', `${menu} > button:nth-of-type(2)`);
  browser('click', `${menu} button:has-text("High")`); wait('!document.querySelector("[data-menu-material]")');
  expect('window.fixture.picker.selections.at(-1).reasoningEffort === "high" && document.querySelector("[data-native-picker] button").textContent.includes("High")');
  browser('click', trigger); browser('click', rootModel);
  browser('fill', `${menu} input`, 'no-such-model');
  expect('document.querySelectorAll("[data-model-group-option]:not([data-model-group-hidden])").length === 0');
  const beforeEmpty = evaluate('window.fixture.picker.selections.length'); browser('press', 'Enter');
  expect(`window.fixture.picker.selections.length === ${beforeEmpty}`);
  browser('fill', `${menu} input`, 'Codex Fast');
  evaluate('window.fixture.picker.rejectNext = true'); browser('press', 'Enter');
  wait('window.fixture.picker.snapshot().error === "Selection rejected by host"');
  expect('window.fixture.picker.snapshot().current.model === "macmini/codex/codex-model"');
  browser('press', 'Escape'); browser('press', 'Escape');
  browser('click', trigger); browser('click', rootModel);
  evaluate('window.fixture.picker.addModel()');
  wait('document.querySelector("[data-model-group=remote-cli-codebuddy] [data-menu-group-heading]")?.getAttribute("data-model-group-count") === "25"');
  expect('document.querySelectorAll("[data-model-group=remote-cli-codebuddy] [data-model-group-option]:not([data-model-group-hidden])").length === 0');
  browser('set', 'viewport', '390', '844');
  expect('(()=>{const r=document.querySelector("[data-menu-material]").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()');
  image('model-groups-mobile');
  browser('press', 'Escape'); browser('press', 'Escape'); wait('!document.querySelector("[data-menu-material]")');
  browser('open', `${base}?fold-persistence`);
  wait('document.querySelector("[data-native-picker] button")'); browser('click', trigger); browser('click', rootModel);
  wait('document.querySelector("[data-model-group]")');
  expect('document.querySelector("[data-model-group=remote-cli-codebuddy] [data-menu-group-heading]").getAttribute("aria-expanded") === "false"');
  // The real native menu and shared selection API must both follow workspace admission.
  evaluate('window.fixture.picker.addOtherMachine()');
  expect('!document.querySelector("[data-menu-material]").textContent.includes("ubuntu")');
  evaluate('window.fixture.workspace("ubuntu")');
  wait('document.querySelectorAll("[data-model-group]").length === 2');
  expect('!document.querySelector("[data-native-picker] button").title.includes("macmini")');
  expect('!document.querySelector("[data-menu-material]").textContent.includes("macmini")');
  browser('click', heading('remote-cli-claude'));
  expect('document.querySelectorAll("[data-model-group=remote-cli-claude] [data-model-group-option]:not([data-model-group-hidden])").length === 1');
  // Rows keep the host as muted text; the composer caption shows only the model, with the host in its tooltip.
  expect('document.querySelector(\'[data-menu-material] [data-model-id="ubuntu/claude/claude-model"] [data-ra-model-host]\').textContent === "ubuntu"');
  browser('click', `${menu} button[title="Claude model · ubuntu"]`); wait('!document.querySelector("[data-menu-material]")');
  wait('document.querySelector("[data-native-picker] button").title.includes("Claude model · ubuntu")');
  expect('document.querySelector("[data-native-picker] [data-model-id]").textContent === "Claude model"');
  const rejected = evaluate('window.fixture.selectModel({provider:"remote-cli-codex",model:"macmini/codex/codex-model"})');
  if (rejected.ok !== false) throw new Error('Cross-machine selection was accepted');
  evaluate('window.fixture.workspace("local")');
  wait('!document.querySelector("[data-native-picker] button").title.includes("ubuntu")');
  // With no current choice, the native trigger opens the model list directly.
  browser('click', trigger);
  wait('document.querySelectorAll("[data-model-group]").length === 1');
  expect('document.querySelector("[data-model-group]").dataset.modelGroup === "deepseek-account"');
  console.log('PASS: native menu filters machines, clears stale captions, rejects cross-machine selection and hides remote models in local workspaces');
  browser('press', 'Escape'); browser('press', 'Escape');
  evaluate('window.fixture.workspace("macmini")');
  browser('open', `${base}?workspace-reset`);
  wait('document.querySelector("[data-native-picker] button").title.includes("macmini")');
  // The usage ring shows context fill; hovering opens the account's plan limits, as in Paseo.
  const hours = h => new Date(Date.now() + h * 3600e3 + 60e3).toISOString();
  const usageFixture = { context: { used: 169000, max: 1000000 }, tokenUsage: { last: { inputTokens: 40000, cachedInputTokens: 30000, outputTokens: 2000 }, total: { inputTokens: 85000, cachedInputTokens: 60000, cacheWriteInputTokens: 0, outputTokens: 5000 } }, account: { provider: 'codex', plan: 'Plus', email: 'dev@example.com', checkedAt: new Date().toISOString(), windows: [{ id: 'codex:primary', label: 'Session', usedPercent: 18, resetsAt: hours(4) }, { id: 'codex:secondary', label: 'Weekly', usedPercent: 35, resetsAt: hours(48) }] } };
  fixture({ seedUsage: usageFixture });
  wait('document.querySelector(".ra-usage")?.getAttribute("aria-label") === "上下文窗口已使用 17%"');
  browser('hover', '.ra-usage');
  wait('document.querySelector(".ra-usage-card")?.textContent.includes("剩余 82%")');
  browser('click', '.ra-usage'); // Keep the card open through viewport and data changes.
  expect('(()=>{const t=document.querySelector(".ra-usage-card").textContent;return t.includes("已使用 17%")&&t.includes("169k / 1m tokens")&&t.includes("Plus")&&t.includes("4h后重置")&&t.includes("剩余 65%")&&t.includes("2d后重置")&&t.includes("dev@example.com")})()');
  expect('(()=>{const s=document.querySelector(".ra-usage-cache"),b=s.querySelector(".ra-usage-cache-toggle");return b.getAttribute("aria-expanded")==="false"&&b.textContent.includes("命中 75%")&&!s.textContent.includes("缓存读取")})()');
  browser('click', '.ra-usage-cache-toggle');
  expect('(()=>{const t=document.querySelector(".ra-usage-cache").textContent;return t.includes("缓存读取30k")&&t.includes("缓存写入未知")&&t.includes("缓存命中比例75%")})()');
  browser('click', '.ra-usage-cache summary');
  expect('document.querySelector(".ra-usage-cache details").open && document.querySelector(".ra-usage-cache details").textContent.includes("缓存读取60k")');
  browser('click', '.ra-usage-cache summary');
  expect('(()=>{const r=document.querySelector(".ra-usage-card").getBoundingClientRect(),b=document.querySelector(".ra-usage").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=b.top})()');
  image('usage-ring-light'); browser('set', 'media', 'dark'); image('usage-ring-dark'); browser('set', 'media', 'light');
  browser('set', 'viewport', '390', '640');
  expect('(()=>{const r=document.querySelector(".ra-usage-card").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()');
  image('usage-ring-mobile'); browser('set', 'viewport', '1440', '1000');
  fixture({ seedUsage: { ...usageFixture, tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0 } } } });
  wait('document.querySelector(".ra-usage-cache")?.textContent.includes("缓存命中比例0%")');
  fixture({ seedUsage: { ...usageFixture, tokenUsage: {} } });
  wait('document.querySelector(".ra-usage-cache")?.textContent.includes("缓存读取未知")');
  expect('!document.querySelector(".ra-usage-cache").textContent.includes("0%")');
  browser('press', 'Escape'); wait('!document.querySelector(".ra-usage-card")');
  browser('hover', '.ra-usage'); wait('document.querySelector(".ra-usage-cache-toggle")?.getAttribute("aria-expanded") === "true"'); // The fold survives reopening.
  browser('click', '.ra-usage');
  evaluate('window.fixture.setLocale("en")');
  wait('document.querySelector(".ra-usage-cache")?.textContent.includes("Cache readUnknown")');
  evaluate('window.fixture.setLocale("zh")');
  browser('press', 'Escape'); wait('!document.querySelector(".ra-usage-card")');
  evaluate('window.fixture.picker.current({provider:"deepseek-account",model:"deepseek-model"})');
  wait('!document.querySelector(".ra-usage")');
  evaluate('window.fixture.picker.current({provider:"remote-cli-codex",model:"macmini/codex/codex-model",reasoningEffort:"medium"})');
  wait('document.querySelector(".ra-usage")');
  console.log('PASS: usage ring reports context, cache reads/writes and token hit rate, distinguishes zero from unknown, opens thread totals and plan limits, fits mobile and hides for non-remote models');
  browser('click', trigger); browser('click', rootModel); wait('document.querySelectorAll("[data-model-group]").length === 4');
  evaluate('window.fixture.disablePlugin()');
  expect('!document.querySelector("[data-model-group],[data-model-group-hidden]")');
  expect('document.querySelectorAll("[data-menu-group] button[role=menuitemradio]").length === 28');
  expect('document.querySelector("[data-menu-group-heading]").getAttribute("role") === null');
  browser('press', 'Escape'); browser('press', 'Escape');
  const pickerErrors = browser('errors'); if (pickerErrors.errors?.length) throw new Error(JSON.stringify(pickerErrors.errors));
  console.log('PASS: official DSH rc.3 model menu, real slot registration, persisted provider folding, visible keyboard selection, search, native reasoning/errors, live catalogs, mobile and plugin disposal');

  // Some DSH builds render model rows without label ids; folding then keys each group by its heading.
  const byName = name => `[data-model-group="name:${name}"]`;
  const openNoIds = () => {
    browser('open', `${base}?no-model-ids`);
    wait('document.querySelector("[data-native-picker] button")'); browser('click', trigger); browser('click', rootModel);
    wait('document.querySelectorAll("[data-model-group]").length === 4');
  };
  openNoIds();
  expect('!document.querySelector("[data-menu-material] [data-provider-id]")');
  expect('[...document.querySelectorAll("[data-model-group]")].every(g => g.dataset.modelGroup === "name:" + g.querySelector(":scope > [data-menu-group-heading]").textContent)');
  expect(`document.querySelector('${byName('Codex')} > [data-menu-group-heading]').getAttribute("aria-expanded") === "true"`);
  expect(`document.querySelector('${byName('CodeBuddy Code')} > [data-menu-group-heading]').getAttribute("aria-expanded") === "false"`);
  expect(`document.querySelectorAll('${byName('CodeBuddy Code')} ${visible}').length === 0`);
  browser('click', `${byName('CodeBuddy Code')} > [data-menu-group-heading]`);
  expect(`document.querySelectorAll('${byName('CodeBuddy Code')} ${visible}').length === 24`);
  browser('press', 'Escape'); browser('press', 'Escape');
  openNoIds();
  expect(`document.querySelector('${byName('CodeBuddy Code')} > [data-menu-group-heading]').getAttribute("aria-expanded") === "true"`);
  browser('click', `${byName('CodeBuddy Code')} > [data-menu-group-heading]`);
  expect(`document.querySelectorAll('${byName('CodeBuddy Code')} ${visible}').length === 0`);
  browser('press', 'Escape'); browser('press', 'Escape');
  const noIdErrors = browser('errors'); if (noIdErrors.errors?.length) throw new Error(JSON.stringify(noIdErrors.errors));
  console.log('PASS: model rows without label ids fold by provider name and keep the choice across reloads');
  }

  // The desktop's custom composer does not render conversation.input.model.label.
  wait('window.fixture?.customModel');
  evaluate('window.customModel = window.fixture.customModel()');
  wait('document.querySelector(".codexModelSelectLabel")?.textContent === "Opus 5.5"');
  expect('document.querySelector(".codexModelSelectTrigger").title === "Opus 5.5 · ubuntu-claude"');
  expect('document.querySelector(".codexModelSelectTrigger").getAttribute("aria-label") === "Opus 5.5 · ubuntu-claude"');
  expect('document.querySelector(".codexModelSelectEffort").textContent === "high" && document.querySelector(".codexModelSelectChevron")');
  evaluate('window.customLabelNode = document.querySelector(".codexModelSelectLabel").firstChild');
  browser('click', '.codexModelSelectTrigger'); expect('window.customModel.clicks() === 1');
  evaluate('window.customModel.render("GPT-5.5 Fast · ubuntu-claude", "medium")');
  wait('document.querySelector(".codexModelSelectLabel")?.textContent === "GPT-5.5 Fast"');
  expect('document.querySelector(".codexModelSelectLabel").firstChild === window.customLabelNode');
  expect('document.querySelector(".codexModelSelectEffort").textContent === "medium"');
  evaluate('window.customModel.render("Other provider · variant")');
  wait('document.querySelector(".codexModelSelectLabel")?.textContent === "Other provider · variant"');
  evaluate('window.customModel.render("Auto · Fast · ubuntu-claude")');
  wait('document.querySelector(".codexModelSelectLabel")?.textContent === "Auto · Fast"');
  image('custom-model-caption');
  evaluate('window.customModel.stop()');
  expect('document.querySelector(".codexModelSelectLabel").textContent === "Auto · Fast · ubuntu-claude"');
  evaluate('window.customModel.render("Opus 5.5 · ubuntu-claude")');
  wait('document.querySelector(".codexModelSelectLabel")?.textContent === "Opus 5.5 · ubuntu-claude"');
  evaluate('window.customModel.unmount()');
  const customErrors = browser('errors'); if (customErrors.errors?.length) throw new Error(JSON.stringify(customErrors.errors));
  console.log('PASS: captured custom composer omits known remote hosts, preserves text nodes, effort, tooltip and clicks, follows React updates and restores on unload');

  }

} finally {
  try { browser('close'); } catch {}
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
