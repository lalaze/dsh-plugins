import { installLocale } from '../../src/client/i18n.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GalleryController } from '../../src/client/controller.js';
import { IndexedGalleryStorage } from '../../src/client/storage.js';
import { GalleryPage } from '../../src/client/gallery.js';
import { installBackground } from '../../src/client/background.js';
import { type Wallpaper } from '../../src/domain.js';

const testMode = new URLSearchParams(location.search).has('test');
const locale = createLocaleFixture();
installLocale({ get: () => locale });
const fixture = { setLocale: locale.setLocale, fail: false, failImage: false, nextDay: false, requests: [] as string[], controller: undefined as GalleryController | undefined, dispose: () => {} };
Object.assign(window, { fixture });
if (testMode) {
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 960, 540); gradient.addColorStop(0, '#183f56'); gradient.addColorStop(0.5, '#91b9b1'); gradient.addColorStop(1, '#e9ac83');
  context.fillStyle = gradient; context.fillRect(0, 0, 960, 540);
  context.fillStyle = '#16394d'; context.beginPath(); context.moveTo(0, 540); context.lineTo(350, 140); context.lineTo(540, 370); context.lineTo(730, 210); context.lineTo(960, 540); context.fill();
  const image = await (await fetch(canvas.toDataURL('image/jpeg'))).blob();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.href);
    if (!url.pathname.startsWith('/api/gallery/')) return nativeFetch(input, init);
    fixture.requests.push(url.href);
    if (url.pathname.endsWith('/bing')) {
      if (fixture.fail) return Response.json({ error: '模拟 Bing 暂时不可用' }, { status: 502 });
      const start = fixture.nextDay ? 24 : 23;
      const entries: Wallpaper[] = Array.from({ length: 8 }, (_, i) => ({
        id: `OHR.Fixture202610${start - i}_1920x1080.jpg`, source: 'bing', date: `2026-10-${start - i}`,
        title: ['山间秋色', '静谧海岸', '秋日森林', '湖光山色', '远方的桥', '暮色原野', '城市印象', '清晨时光'][i],
        market: url.searchParams.get('market') === 'en-US' ? 'en-US' : 'zh-CN', copyright: '© 界面测试图片', copyrightUrl: 'https://www.bing.com/search?q=landscape',
      }));
      return Response.json({ entries });
    }
    if (fixture.failImage) return new Response(null, { status: 503 });
    return new Response(image);
  };
}
const controller = new GalleryController(new IndexedGalleryStorage());
fixture.controller = controller;
const detach = installBackground(controller); const stop = controller.start();
fixture.dispose = () => { detach(); stop(); };
window.addEventListener('beforeunload', fixture.dispose);

const style = document.createElement('style'); style.textContent = `
:root{color-scheme:light;--dsw-alias-bg-base:#f9fafc;--dsw-alias-bg-layer-2:#fff;--dsw-specific-sidebar-fill:#f0f1f5;--dsw-alias-bg-module-platform:#f1f3f6;--dsw-alias-border-l2:#e5e7ed;--dsw-alias-label-primary:#242834;--dsw-alias-label-tertiary:#7b808e;--dsw-alias-state-business-primary:#517ede}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--dsw-alias-bg-base:#17181c;--dsw-alias-bg-layer-2:#1d1e23;--dsw-specific-sidebar-fill:#191a1f;--dsw-alias-bg-module-platform:#ffffff08;--dsw-alias-border-l2:#ffffff12;--dsw-alias-label-primary:#e5e7ed;--dsw-alias-label-tertiary:#8d919f;--dsw-alias-state-business-primary:#83a6f4}}
html,body,#root,#root>[data-slot=root]{height:100%;margin:0;color:var(--dsw-alias-label-primary);font:14px system-ui}body{background:var(--dsw-alias-bg-base)}
.fixture-frame{height:100%;display:grid;grid-template-columns:210px 1fr;background:var(--dsw-alias-bg-base)}.fixture-frame>aside>[data-slot=sidebar]{height:100%}.fixture-sidebar{background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l2);padding:26px 14px;display:flex;flex-direction:column;gap:20px}.fixture-sidebar strong{font-size:15px;letter-spacing:.03em;padding:0 10px}.fixture-sidebar small{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary);padding:0 10px}.fixture-sidebar button{border:0;padding:10px 12px;border-radius:7px;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit;font-size:13px}.fixture-sidebar button[aria-pressed=true]{background:var(--dsw-alias-bg-module-platform)}.fixture-nav{display:flex;flex-direction:column;gap:4px}.fixture-foot{margin-top:auto;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.7;padding:0 10px}.fixture-main{min-width:0;overflow:auto}.fixture-page{min-height:100%;background:var(--dsw-alias-bg-base);padding:28px 28px 0}.fixture-page>.dsh-gallery{max-width:1600px;margin:auto}.fixture-chat{max-width:720px;margin:20vh auto;padding:24px;text-align:center}.fixture-chat h1{font-size:28px;font-weight:500}.fixture-composer{padding:18px;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);margin-top:40px;color:var(--dsw-alias-label-tertiary)}
@media(max-width:700px){.fixture-frame{grid-template-columns:1fr}.fixture-sidebar{display:none}.fixture-page{padding:18px 2px 0}}
`; document.head.append(style);
function Preview() {
  const [page, setPage] = useState('gallery');
  return <div data-slot="root"><div className="fixture-frame">
    <aside><div data-slot="sidebar"><div className="fixture-sidebar" style={{ height: '100%', boxSizing: 'border-box' }}>
      <strong>DeepSeek Harness</strong><small>设置</small>
      <nav className="fixture-nav"><button aria-pressed={page === 'chat'} onClick={() => setPage('chat')}>聊天预览</button><button aria-pressed={page === 'gallery'} onClick={() => setPage('gallery')}>▧　图库</button></nav>
      <div className="fixture-foot">图库插件 · 独立界面预览<br />{testMode ? '自动化测试图片' : 'Bing 图片与本地存储均为真实数据'}</div>
    </div></div></aside>
    <main className="fixture-main"><div data-slot="main"><div data-slot="main.conversation"><div data-phase="hero" className="fixture-page">
      {page === 'gallery' ? <GalleryPage controller={controller} /> : <div className="fixture-chat"><h1>今天，想做点什么？</h1><p>你的背景会出现在聊天和侧栏。</p><div className="fixture-composer">向 DeepSeek 发送消息…</div></div>}
    </div></div></div></main>
    <div data-shell-overlay style={{ display: 'none' }} />
  </div></div>;
}
const root = document.createElement('div'); root.id = 'root'; document.body.append(root); createRoot(root).render(<Preview />);
