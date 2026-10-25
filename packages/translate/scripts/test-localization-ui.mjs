import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  browser('click', '[data-dsh-translate-draft]');
  wait('document.querySelector("[data-dsh-translate-draft]").textContent === "Undo"');
  expect('document.querySelector("[data-composer-input]").value === "Hello world"');
  browser('click', '[data-dsh-browser-devtools=toggle]');
  const guest = 'document.querySelector("iframe").contentDocument';
  wait(`${guest}.querySelector(".dsh-bdt-title")?.textContent === "Page debugger"`);
  evaluate('window.fixture.setLocale("zh-CN")');
  wait('document.querySelector(".dsh-translate-settings h2").textContent === "翻译 API"');
  wait(`${guest}.querySelector(".dsh-bdt-title").textContent === "网页调试器"`);
  expect('document.querySelector("[data-dsh-translate-draft]").textContent === "撤销"');
  expect('document.querySelector("[data-dsh-browser-devtools=toggle]").getAttribute("aria-label") === "关闭调试浮窗"');
  expect('document.querySelector("select").textContent.includes("日语") && document.body.textContent.includes("备用 API 地址")');
  browser('click', '[data-dsh-translate-draft]');
  expect('document.querySelector("[data-composer-input]").value === "你好世界"');
  browser('fill', 'textarea:not([data-composer-input])', 'Test input');
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
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: English fallback, live translation and guest debugger localization, target languages, fallback fields, undo state and localized errors');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
