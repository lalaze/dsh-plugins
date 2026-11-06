import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installLiveImages, liveImagePath } from '../src/client/sessions/live-images.js';

const COPY = `/Users/me/.dsh/storages/dsh-remote-agents/chat-images/${'a'.repeat(64)}.png`;
const globals = ['window', 'document', 'MutationObserver', 'HTMLElement'] as const;
let dispose = () => {};

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body><div id="chat"></div></body>', { url: 'https://dsh.test/app/' });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
});
afterEach(() => {
  dispose(); dispose = () => {};
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

/** DSH's alt text as React leaves it: the component above it holds the image's destination. */
const altText = (destination: unknown, text = 'shot.png', className = '_imageAlt_1ypvv_287') => {
  const span = document.createElement('span');
  span.className = className; span.textContent = text;
  Object.assign(span, { __reactFiber$abc: { return: { memoizedProps: { destination, alt: text, streaming: true } } } });
  return span;
};
const chat = () => document.getElementById('chat')!;
const settle = () => new Promise(resolve => setImmediate(resolve));
const shown = (span: Element) => span.querySelector('img');

test('a kept copy shows as an image from the same file address DSH uses, once its alt text appears', async () => {
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle();
  const image = shown(span)!;
  assert.equal(image.src, `https://dsh.test/app/api/file?path=${encodeURIComponent(COPY)}`);
  assert.equal(image.alt, 'shot.png');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(span.firstChild?.nodeValue, 'shot.png', 'React still finds its text');
});

test('in the desktop app the address stays on the app\'s own scheme, the only form DSH accepts there', async () => {
  const base = document.createElement('base'); base.href = 'dsh-app://app/'; document.head.append(base);
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle();
  assert.equal(shown(span)!.src, `dsh-app://app/api/file?path=${encodeURIComponent(COPY)}`);
});

test('alt text inside a whole block DSH adds is found too, and one already on the page when this loads', async () => {
  const early = altText(COPY); chat().append(early);
  dispose = installLiveImages();
  assert.ok(shown(early));
  const block = document.createElement('p'), span = altText(COPY);
  block.append(span); chat().append(block); await settle();
  assert.ok(shown(span));
});

test('a path with spaces is decoded once, as DSH decodes it', () => {
  const spaced = COPY.replace('/me/', '/my name/');
  assert.equal(liveImagePath(altText(spaced.replaceAll(' ', '%20'))), spaced);
  assert.equal(liveImagePath(altText(spaced)), spaced);
});

test('other images in a reply stay with DSH', async () => {
  dispose = installLiveImages();
  const others = ['/Users/me/shot.png', './chat-images/shot.png', `/x/chat-images/${'a'.repeat(63)}.png`, `${COPY}/more.png`, 'https://example.com/a.png', '%E0%A4%A', 42]
    .map(destination => altText(destination));
  const unrelated = altText(COPY, 'x', 'caption');
  chat().append(...others, unrelated); await settle();
  for (const span of [...others, unrelated]) assert.equal(shown(span), null);
});

test('alt text with no component holding a destination stays as it is', async () => {
  dispose = installLiveImages();
  const plain = document.createElement('span'); plain.className = '_imageAlt_1ypvv_287'; plain.textContent = 'plain';
  const bare = altText(COPY); Object.assign(bare, { __reactFiber$abc: { return: null } });
  chat().append(plain, bare); await settle();
  assert.equal(shown(plain), null);
  assert.equal(shown(bare), null);
});

test('a copy that cannot be read goes back to its alt text and is not tried again', async () => {
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle();
  shown(span)!.dispatchEvent(new window.Event('error'));
  assert.equal(shown(span), null);
  assert.equal(span.textContent, 'shot.png');
  chat().append(altText('/elsewhere.png')); await settle();
  assert.equal(shown(span), null);
});

test('an image appended to DSH\'s element does not start another one', async () => {
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle(); await settle();
  assert.equal(span.querySelectorAll('img').length, 1);
});

test('unloading the plugin leaves the page as DSH drew it', async () => {
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle();
  dispose(); dispose = () => {};
  assert.equal(shown(span), null);
  assert.equal(document.querySelector('style[data-remote-live-images]'), null);
  const later = altText(COPY); chat().append(later); await settle();
  assert.equal(shown(later), null);
});

const preview = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = (key: string) => { const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); document.activeElement!.dispatchEvent(event); return event; };
const opened = async () => {
  dispose = installLiveImages();
  const span = altText(COPY); chat().append(span); await settle();
  const button = span.querySelector('button')!;
  button.focus(); button.click();
  return { span, button, close: preview()!.querySelector('button')! };
};

test('clicking an image opens its preview, from the same file and with the focus on closing it', async () => {
  const { span, button, close } = await opened();
  assert.equal(button.getAttribute('aria-label'), 'View full image: shot.png');
  assert.equal(preview()!.getAttribute('aria-modal'), 'true');
  assert.equal(preview()!.parentElement, document.body, 'outside the conversation, where Escape would count towards stopping the turn');
  const image = preview()!.querySelector('img')!;
  assert.equal(image.src, shown(span)!.src);
  assert.equal(image.alt, 'shot.png');
  assert.equal(document.activeElement, close);
});

test('Escape closes the preview, goes no further, and returns the focus', async () => {
  const { button } = await opened();
  let reached = false;
  document.addEventListener('keydown', () => { reached = true; });
  press('Escape');
  assert.equal(preview(), null);
  assert.equal(reached, false, 'the conversation must not see this Escape');
  assert.equal(document.activeElement, button);
  press('Escape');
  assert.equal(reached, true, 'closed, it no longer takes the key');
});

test('Tab stays on the close button, and the close button and the mask both close the preview', async () => {
  const { button, close } = await opened();
  assert.equal(press('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, close);
  close.click();
  assert.equal(preview(), null);
  button.click();
  preview()!.querySelector('[aria-hidden="true"]:not(svg)')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(preview(), null);
});

test('a preview stays open when the turn ends under it, and still closes', async () => {
  const { span } = await opened();
  span.remove();
  assert.ok(preview());
  press('Escape');
  assert.equal(preview(), null);
});

test('unloading the plugin closes an open preview', async () => {
  await opened();
  dispose(); dispose = () => {};
  assert.equal(preview(), null);
});
