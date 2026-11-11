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
createRoot(host).render(<AssetsPanel sessionId="preview" openFile={(_session, path, line) => { opened.push(line ? `${path}:${line}` : path); }} />);
