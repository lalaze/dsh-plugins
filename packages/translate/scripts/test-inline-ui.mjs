import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'dsh-inline-ui-'));
const session = `dsh-inline-${process.pid}`;
const browser = (...args) => {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 35000 }));
  if (!result.success) throw new Error(result.error);
  return result.data;
};
const evaluate = script => browser('eval', '-b', Buffer.from(script).toString('base64')).result;
const wait = script => browser('wait', '--fn', script);
const expect = script => { if (!evaluate(script)) throw new Error(`UI assertion failed: ${script}`); };
const card = 'document.querySelector(".dsh-translate-paragraph-card")';
const count = 'document.querySelectorAll(".dsh-translate-paragraph-card").length';
const open = selector => {
  evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView(); document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}))`);
  browser('click', '.dsh-translate-paragraph-button');
};
try {
  const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['test/ui/inline.fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  const file = join(temp, 'index.html');
  await writeFile(file, '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
  browser('--executable-path', process.env.DSH_TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--allow-file-access', 'open', pathToFileURL(file).href);
  wait('document.querySelector("#first") !== null');
  browser('snapshot', '-i');
  evaluate('window.beforeTop = document.querySelector("#second").getBoundingClientRect().top; window.fixture.defer = true');
  open('#first');
  wait(`${card}?.dataset.state === "busy"`);
  expect(`${card}.previousElementSibling.id === "first" && ${card}.nextElementSibling.id === "second" && getComputedStyle(${card}).position === "relative"`);
  evaluate('window.fixture.resolve(); window.fixture.defer = false');
  wait(`${card}?.dataset.state === "done"`);
  expect(`document.querySelector("#second").getBoundingClientRect().top > window.beforeTop && ${card}.getBoundingClientRect().bottom <= document.querySelector("#second").getBoundingClientRect().top`);
  if (process.env.DSH_TEST_SCREENSHOT) browser('screenshot', process.env.DSH_TEST_SCREENSHOT);
  evaluate(`const range = document.createRange(); range.selectNodeContents(${card}.firstElementChild); getSelection().removeAllRanges(); getSelection().addRange(range); ${card}.firstElementChild.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));`);
  expect('!document.querySelector("[data-selection-control]")');
  evaluate('getSelection().removeAllRanges()');
  browser('click', 'textarea');
  expect(`${count} === 1`);
  evaluate(`window.cardTop = ${card}.getBoundingClientRect().top; document.querySelector('#scroll').scrollTop = 30`);
  expect(`${card}.getBoundingClientRect().top < window.cardTop && ${count} === 1`);
  // Opening another paragraph must keep the first translation visible.
  open('#second');
  wait(`${count} === 2`);
  open('#second');
  wait(`${count} === 1`);
  // A streamed update invalidates the old translation without breaking React reconciliation.
  evaluate('window.fixture.update("A new streamed paragraph.")');
  wait(`${count} === 0`);
  open('#item');
  wait(`${card}?.dataset.state === "done"`);
  expect(`${card}.parentElement.id === "item" && ${card}.nextElementSibling.tagName === "UL" && window.fixture.text === "A list item with context."`);
  open('#nested');
  wait(`${count} === 2`);
  expect('window.fixture.text === "Nested item." && document.querySelectorAll("li").length === 2');
  browser('press', 'Escape');
  wait(`${count} === 0`);
  open('#heading');
  wait(`${card}?.dataset.state === "done"`);
  expect(`${card}.previousElementSibling.id === "heading"`);
  browser('press', 'Escape');
  open('#quote');
  wait(`${card}?.dataset.state === "done"`);
  expect(`${card}.parentElement.id === "quote"`);
  // Translating a word in a block already containing a result must exclude that result from context.
  evaluate(`const scope = document.querySelector('#quote'); const range = document.createRange(); range.setStart(scope.firstChild, 2); range.setEnd(scope.firstChild, 7); getSelection().removeAllRanges(); getSelection().addRange(range); scope.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
  wait(`${count} === 2`);
  expect('window.fixture.text === "plain" && window.fixture.context === "A plain quote."');
  browser('press', 'Escape');
  evaluate('window.fixture.translation = "长译文".repeat(500)');
  browser('set', 'viewport', '390', '844');
  open('#first');
  wait(`${card}?.dataset.state === "done"`);
  expect(`${card}.scrollHeight <= ${card}.clientHeight + 1 && document.documentElement.scrollWidth <= innerWidth && ${card}.getBoundingClientRect().bottom <= document.querySelector('#second').getBoundingClientRect().top`);
  browser('press', 'Escape');
  evaluate('window.fixture.fail = true');
  open('#first');
  wait(`${card}?.dataset.state === "error"`);
  browser('click', '.dsh-translate-paragraph-close');
  wait(`${count} === 0`);
  evaluate('window.fixture.fail = false; window.fixture.defer = true');
  open('#first');
  wait(`${card}?.dataset.state === "busy"`);
  browser('click', '.dsh-translate-paragraph-close');
  evaluate('window.fixture.resolve(); window.fixture.defer = false');
  expect(`${count} === 0`);
  open('#first');
  wait(`${card}?.dataset.state === "done"`);
  evaluate('window.fixture.unmount()');
  wait(`${count} === 0`);
  evaluate('window.fixture.dispose()');
  expect('!document.querySelector("[data-dsh-translate-paragraph]")');
  const errors = browser('errors'); if (errors.errors?.length) throw new Error(JSON.stringify(errors));
  console.log('PASS: inline layout, persistent results, scroll, nested lists, headings, quotes, word context, streaming updates, narrow viewport, errors, pending close and React unmount');
} finally {
  try { browser('close'); } catch {}
  await rm(temp, { recursive: true, force: true });
}
