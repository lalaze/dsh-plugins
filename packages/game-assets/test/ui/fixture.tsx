import React from 'react';
import { createRoot } from 'react-dom/client';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import { installLocale } from '../../src/client/i18n.js';
import { AssetsPanel } from '../../src/client/panel.js';

const locale = createLocaleFixture();
installLocale({ get: () => locale });
const opened: string[] = [];
Object.assign(window, { fixture: { setLocale: locale.setLocale, opened } });
const style = document.createElement('style');
style.textContent = 'html,body,#root{height:100%;margin:0}body{font-family:system-ui,sans-serif;color-scheme:light dark;background:Canvas;color:CanvasText}';
document.head.append(style);
const host = document.createElement('div');
host.id = 'root';
document.body.append(host);
// `?dsh` and `?grow` put the view inside a copy of DSH's conversation area: a view area that grows with its content in a
// scrolling area, with the composer docked below. `?grow` leaves out DSH's markers, as an unknown host would.
const layout = new URLSearchParams(location.search).get('dsh') !== null ? 'dsh' : new URLSearchParams(location.search).get('grow') !== null ? 'grow' : undefined;
let mount: HTMLElement = host;
if (layout) {
  host.innerHTML = `<div style="height:100%;display:flex;flex-direction:column"><div ${layout === 'dsh' ? 'data-conversation-scroll' : 'data-x'} style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column">
    <div ${layout === 'dsh' ? 'data-slot="conversation.session"' : ''} style="display:flex;flex-direction:column;flex:1 0 auto"><div id="view-area" style="flex:1 0 auto;min-height:auto;display:flex;flex-direction:column"></div></div>
    <div ${layout === 'dsh' ? 'data-composer-seat' : ''} style="position:sticky;bottom:0;margin-top:auto;height:72px;flex:none;background:#ddd">composer</div></div></div>`;
  mount = host.querySelector<HTMLElement>('#view-area')!;
}
const counted = window.fetch.bind(window), batches: number[] = [];
window.fetch = async (input, init) => {
  try { const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; if (body?.action === 'images') batches.push(body.paths.length); } catch { /* not JSON */ }
  return counted(input, init);
};
Object.assign((window as unknown as { fixture: object }).fixture, { batches });
createRoot(mount).render(<AssetsPanel sessionId="preview" openFile={(_session, path, line) => { opened.push(line ? `${path}:${line}` : path); }} />);
