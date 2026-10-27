import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'dsh-localization-ui-'));
const session = `dsh-localization-${process.pid}`;
const browser = (...args) => {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000 }));
  if (!result.success) throw new Error(result.error);
  return result.data;
};
const evaluate = script => browser('eval', '-b', Buffer.from(script).toString('base64')).result;
const wait = script => browser('wait', '--fn', script);
const expect = script => { if (!evaluate(script)) throw new Error(`UI assertion failed: ${script}`); };
try {
  const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['test/ui/localization.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  const file = join(temp, 'index.html');
  await writeFile(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
  const url = pathToFileURL(file).href;
  const executable = process.env.DSH_TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser('--executable-path', executable, '--allow-file-access', 'open', url);
  wait('document.querySelector(".dsh-translate-settings h2")?.textContent === "Translation API"');
  browser('snapshot', '-i');
  expect('document.querySelector("select").textContent.includes("Japanese") && document.body.textContent.includes("Fallback API URL")');
  const draft = 'document.querySelector("[data-dsh-translate-draft]")';
  const label = `${draft}.getAttribute("aria-label")`;
  const lock = 'document.querySelector("[data-dsh-translate-lock]")';
  // Claude is locked to English by default; the compact icon explains its target in the tooltip.
  expect(`${draft}.dataset.dshTranslateTarget === "en" && !${lock} && ${draft}.title === "Translate draft to English (Alt/Option+T)"`);
  expect(`${draft}.textContent === "" && ${draft}.children.length === 1 && ${draft}.firstElementChild.tagName.toLowerCase() === "svg" && ${draft}.getBoundingClientRect().width === 28`);
  browser('click', '[data-dsh-translate-draft]');
  wait(`${label} === "Undo"`);
  expect('document.querySelector("[data-fixture-composer]").value === "Hello world" && window.fixture.draft === "Hello world" && window.fixture.lastTarget === "en" && window.fixture.lastText === "你好世界"');
  expect('document.querySelector("[hidden] textarea").value === "另一个会话的草稿"');
  expect(`${draft}.textContent === "" && ${draft}.querySelector("svg") !== null && ${draft}.title === "Undo"`);
  browser('click', '[data-dsh-browser-devtools=toggle]');
  const guest = 'document.querySelector("iframe").contentDocument';
  wait(`${guest}.querySelector(".dsh-bdt-title")?.textContent === "Page debugger"`);
  evaluate('window.fixture.setLocale("zh-CN")');
  wait('document.querySelector(".dsh-translate-settings h2").textContent === "翻译 API"');
  wait(`${guest}.querySelector(".dsh-bdt-title").textContent === "网页调试器"`);
  expect(`${label} === "撤销"`);
  expect('document.querySelector("[data-dsh-browser-devtools=toggle]").getAttribute("aria-label") === "关闭调试浮窗"');
  expect('document.querySelector("select").textContent.includes("日语") && document.body.textContent.includes("备用 API 地址")');
  browser('click', '[data-dsh-translate-draft]');
  expect('document.querySelector("[data-fixture-composer]").value === "你好世界" && window.fixture.draft === "你好世界"');
  // Other models keep automatic direction until their keyword is configured.
  evaluate('window.fixture.setModel("deepseek-official", "deepseek-flash")');
  wait(`${draft}.dataset.dshTranslateTarget === "auto" && !${lock} && ${draft}.title === "翻译草稿（Alt/Option+T）"`);
  browser('click', '[data-dsh-translate-draft]');
  wait(`${label} === "撤销"`);
  expect('window.fixture.lastTarget === "auto"');
  browser('click', '[data-dsh-translate-draft]');
  browser('fill', 'input[placeholder="claude, anthropic"]', 'claude, deepseek');
  browser('click', '.dsh-translate-actions button:text-is("保存设置")');
  wait(`${draft}.dataset.dshTranslateTarget === "en" && !${lock} && ${draft}.title === "将草稿翻译为英文（Alt/Option+T）"`);
  expect('JSON.parse(localStorage.getItem("dsh-translate.settings.v1")).englishLockModels === "claude, deepseek"');
  // A response for an older draft must leave newer edits intact and must not offer Undo.
  evaluate('window.fixture.defer = true');
  const requests = evaluate('window.fixture.requests');
  browser('click', '[data-dsh-translate-draft]');
  wait(`${draft}.dataset.dshTranslateBusy !== undefined`);
  evaluate('document.querySelector("[data-fixture-composer]").dispatchEvent(new KeyboardEvent("keydown", {bubbles: true, altKey: true, key: "t"}))');
  expect(`window.fixture.requests === ${requests + 1}`);
  evaluate('window.fixture.setDraft("翻译期间修改的新草稿")');
  wait('window.fixture.draft === "翻译期间修改的新草稿"');
  evaluate('window.fixture.resolveTranslation()');
  wait(`${draft}.dataset.dshTranslateBusy === undefined`);
  expect(`window.fixture.draft === "翻译期间修改的新草稿" && document.querySelector("[data-fixture-composer]").value === window.fixture.draft && ${draft}.dataset.dshTranslateUndo === undefined && ${label} !== "撤销"`);
  // Undo restores the exact draft, including leading/trailing whitespace and line breaks.
  evaluate('window.fixture.defer = false; window.fixture.setDraft("  第一行\\n第二行\\n  ")');
  wait('window.fixture.draft === "  第一行\\n第二行\\n  "');
  browser('click', '[data-dsh-translate-draft]');
  wait(`${label} === "撤销"`);
  expect('window.fixture.draft === "Hello world"');
  browser('click', '[data-dsh-translate-draft]');
  expect('window.fixture.draft === "  第一行\\n第二行\\n  " && document.querySelector("[data-fixture-composer]").value === window.fixture.draft');
  browser('fill', '.dsh-translate-settings textarea', 'Test input');
  evaluate('window.fixture.fail = true');
  browser('click', '.dsh-translate-actions button:text-is("翻译")');
  wait('document.querySelector("[role=alert]")?.textContent === "请先填写翻译模型名"');
  evaluate('window.fixture.setLocale("en")');
  wait('document.querySelector("[role=alert]").textContent === "Enter a translation model first"');
  wait(`${guest}.querySelector(".dsh-bdt-title").textContent === "Page debugger"`);
  browser('set', 'viewport', '390', '844');
  expect('document.querySelector(".dsh-translate-settings").scrollWidth <= innerWidth');
  browser('open', `${url}?noLocale`);
  wait('document.querySelector(".dsh-translate-settings h2")?.textContent === "Translation API"');
  evaluate('window.fixture.setLocale("zh")');
  expect('document.querySelector(".dsh-translate-settings h2").textContent === "Translation API"');
  // Exercise actual Cordis startup with a desktop locale service that arrives later.
  const settings = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['test/ui/settings-locale.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  const settingsFile = join(temp, 'settings.html');
  await writeFile(settingsFile, '<!doctype html><html><meta charset="utf-8"><body><script>' + settings.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
  browser('open', pathToFileURL(settingsFile).href);
  wait('document.body.dataset.fixtureReady !== undefined');
  const activatedBeforeLocale = evaluate('document.querySelectorAll("[data-plugin]").length');
  evaluate('window.fixture.startLocale()');
  wait('document.querySelectorAll("[data-plugin]").length === 2');
  const labelsAfterStartup = evaluate('[...document.querySelectorAll("[data-plugin]")].map(button => button.textContent)');
  if (activatedBeforeLocale || labelsAfterStartup.join(',') !== '翻译,使用量统计') throw new Error(`Async locale startup: ${activatedBeforeLocale} settings activated too early; labels after Chinese host became ready: ${labelsAfterStartup.join(', ')}`);
  const translationLabel = 'document.querySelector("[data-plugin=translate]")?.textContent';
  const usageLabel = 'document.querySelector("[data-plugin=usage-stats]")?.textContent';
  wait(`${translationLabel} === "翻译" && ${usageLabel} === "使用量统计"`);
  wait('document.querySelector(".dsh-translate-settings h2")?.textContent === "翻译 API" && document.querySelector(".us-title h2")?.textContent === "使用量统计"');
  evaluate('window.fixture.setLocale("en")');
  wait(`${translationLabel} === "Translation" && ${usageLabel} === "Usage statistics"`);
  wait('document.querySelector(".dsh-translate-settings h2").textContent === "Translation API" && document.querySelector(".us-title h2").textContent === "Usage statistics"');
  evaluate('window.fixture.setLocale("zh")');
  wait(`${translationLabel} === "翻译" && ${usageLabel} === "使用量统计"`);
  wait('document.querySelector(".dsh-translate-settings h2").textContent === "翻译 API" && document.querySelector(".us-title h2").textContent === "使用量统计"');
  for (const plugin of ['translate', 'usage-stats']) {
    const manifest = JSON.parse(await readFile(new URL(`../../${plugin}/package.json`, import.meta.url), 'utf8'));
    if (!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale')) throw new Error(`${plugin}: locale package must be loaded by DSH`);
  }
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: scoped controlled composer replacement, inactive composer isolation, pending edits, duplicate requests, exact undo, async host locale startup, settings localization, model English lock and localized errors');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
