import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client/index.js';
import type { AccountQuota, QuotaReport } from '../../src/types.js';

let Strip!: React.FC; let Dashboard!: React.FC;
const now = new Date().toISOString();
const reset = new Date(Date.now() + 128 * 60000).toISOString();
const window = (id: string, name: string, remaining: number) => ({ id, name, remaining, unlimited: false, resetsAt: reset });
const accounts: AccountQuota[] = [
  { id: 'grok-one', provider: 'grok', name: 'Grok', kind: 'subscription', user: 'personal@example.com', plan: 'SuperGrok', readAt: now, refreshable: true, windows: [window('weekly', '7 days', 80)] },
  { id: 'codex-one', provider: 'codex', name: 'Codex', kind: 'subscription', user: 'work@example.com', plan: 'Plus', readAt: now, last: true, refreshable: true, windows: [window('five', '5 hours', 75), window('weekly', '7 days', 63)] },
  { id: 'claude-one', provider: 'claude', name: 'Claude', kind: 'subscription', user: 'studio@example.com', plan: 'Max', readAt: now, refreshable: true, windows: [window('five', '5 hours', 100), window('weekly', '7 days', 100)] },
  { id: 'gemini-one', provider: 'gemini', name: 'Gemini', kind: 'subscription', user: 'design@example.com', plan: 'AI Pro', readAt: now, refreshable: true, windows: [window('daily', '1 day', 88)] },
];
const locale = createLocaleFixture();
const fixture = { setLocale: locale.setLocale,
  scenario: 'normal', failRead: new URLSearchParams(globalThis.location.search).has('failRead'), failRefresh: false, reads: 0, writes: 0, registrations: [] as Record<string, unknown>[],
  report(): QuotaReport {
    const data = structuredClone(accounts);
    if (this.scenario === 'many') {
      for (let i = 0; i < 14; i++) data.push({ ...structuredClone(accounts[i % 4]), id: `extra-${i}`, user: `team-${i}@example.com` });
    }
    if (this.scenario === 'error') data[1] = { ...data[1], windows: [], error: '此账号额度读取失败，请检查登录状态', readAt: undefined };
    if (this.scenario === 'low') { data[1].windows[1].remaining = 8; data[0].windows[0].remaining = 20; }
    if (this.scenario === 'unlimited') data[0].windows = [{ id: 'unlimited', name: 'Requests', remaining: null, unlimited: true }];
    return { generatedAt: new Date().toISOString(), gateways: this.scenario === 'empty' ? [] : [{ id: 'office', name: 'Office Magpie', accounts: this.scenario === 'forbidden' ? [] : data,
      ...(this.scenario === 'forbidden' ? { error: { code: 'FORBIDDEN', message: '网关密钥无权查看这些账号的额度' } } : {}),
      ...(this.scenario === 'stale' ? { stale: true, error: { code: 'UNREACHABLE', message: '无法连接 Magpie，请检查网关地址' } } : {}) }] };
  },
};
Object.assign(globalThis, { fixture });
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith('/api/magpie-quota')) return originalFetch(input, init);
  if (init?.method === 'POST') {
    fixture.writes++;
    if (fixture.failRefresh) return Response.json({ error: '刷新失败，请稍后重试' }, { status: 502 });
    const { accountId } = JSON.parse(init.body as string);
    const account = accounts.find(a => a.id === accountId);
    if (account) { account.windows = account.windows.map(w => ({ ...w, remaining: 92 })); account.readAt = new Date().toISOString(); }
  } else {
    fixture.reads++;
    if (fixture.failRead) return Response.json({}, { status: 500 });
  }
  return Response.json(fixture.report());
};
apply({ get: () => locale, effect: setup => { setup(); }, slots: { inject: (_name, factory) => factory(), register: (spec, component) => {
  fixture.registrations.push(spec);
  if (spec.name === 'conversation.composer.dock') Strip = component;
  else Dashboard = component;
} } });

function Fixture() {
  const [dashboard, setDashboard] = useState(false);
  return <div className="preview">
    <aside className="preview-sidebar"><div className="preview-brand">dsh<span>preview</span></div><button type="button" onClick={() => setDashboard(false)}>＋ 新会话</button><div className="preview-nav">最近会话</div><div className="preview-session">Magpie 额度插件</div><button className="preview-settings" type="button" aria-label="打开 Magpie 额度设置" onClick={() => setDashboard(true)}>⚙ Magpie 额度</button></aside>
    <main className="preview-main"><header className="preview-header"><span>{dashboard ? '设置 / Magpie 额度' : 'Magpie 额度插件'}</span><span className="preview-demo">演示数据</span></header>
    {dashboard ? <Dashboard /> : <div className="preview-chat"><div className="preview-conversation"><div className="preview-user">随时看一下每个账号还剩多少额度。</div><div className="preview-answer"><span className="preview-answer-mark">✳</span><div>各账号的剩余额度会显示在输入框下方。<br /><span>点击一个图标，查看窗口明细和重置时间。</span></div></div></div>
      <div className="preview-composer-zone"><div className="preview-composer" data-composer-card><div contentEditable suppressContentEditableWarning role="textbox" aria-label="消息" className="preview-editor" data-placeholder="继续对话…" /><div className="preview-toolbar"><span>＋</span><span>◉ Auto-review⌄</span><span className="preview-model">GPT-6.1-Sol⌄</span><button type="button" aria-label="发送演示消息" disabled>↑</button></div></div><div className="preview-dock" data-composer-dock><Strip /><span className="preview-context">12% context</span></div></div>
    </div>}
    </main>
  </div>;
}
document.head.insertAdjacentHTML('beforeend', `<style>
*{box-sizing:border-box}:root{color-scheme:light dark}body{margin:0;background:#f8f9fa;color:#30333a;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.preview{display:flex;min-height:100dvh}.preview-sidebar{width:208px;flex:none;background:#f0f1f3;border-right:1px solid #e5e6e9;padding:22px 14px;position:relative}.preview-brand{font-size:22px;font-weight:650;padding:0 12px 26px;letter-spacing:-1px}.preview-brand span{font-size:10px;font-weight:400;letter-spacing:1px;margin-left:10px;color:#9a9da3}.preview-sidebar button{background:transparent;color:inherit;border:0;border-radius:7px;padding:8px 12px;text-align:left;width:100%;cursor:pointer;font:inherit}.preview-sidebar button:hover{background:#00000005}.preview-nav{font-size:10px;color:#969ba3;padding:25px 12px 10px;letter-spacing:.6px}.preview-session{background:#e5e7eb;border-radius:7px;padding:9px 12px;font-size:12px}.preview-settings{position:absolute;bottom:18px;left:14px;width:180px!important;color:#9297a0!important}.preview-main{flex:1;min-width:0;display:flex;flex-direction:column;height:100dvh}.preview-header{height:62px;border-bottom:1px solid #eceef0;display:flex;justify-content:space-between;align-items:center;padding:0 28px;font-size:12px;flex:none}.preview-demo{font-size:10px;color:#999fa7;border:1px solid #e2e5e9;border-radius:5px;padding:1px 7px}.preview-chat{flex:1;min-height:0;display:flex;flex-direction:column;max-width:880px;width:100%;padding:0 38px 20px;margin:0 auto}.preview-conversation{flex:1;padding-top:90px}.preview-user{margin-left:auto;width:max-content;max-width:90%;padding:12px 18px;border-radius:17px;background:#eeeff1;font-size:13px}.preview-answer{display:flex;gap:14px;padding:40px 4px;color:#484d55;font-size:14px;line-height:2}.preview-answer span{color:#8f959e;font-size:12px}.preview-answer-mark{font-size:22px!important;color:#83a38f!important;line-height:1.5}.preview-composer-zone{width:100%;margin-top:20px}.preview-composer{background:#fff;border:1px solid #e6e8eb;border-radius:17px;padding:12px 12px 9px;box-shadow:0 2px 10px #00000003}.preview-editor{min-height:72px;outline:0;padding:2px 6px}.preview-editor:empty:before{content:attr(data-placeholder);color:#adb1b7}.preview-toolbar{display:flex;align-items:center;gap:18px;color:#9499a2;font-size:11px;white-space:nowrap}.preview-toolbar>span:first-child{font-size:20px}.preview-model{margin-left:auto}.preview-toolbar button{background:#edf0ee;color:#adb7b0;border:0;border-radius:50%;width:27px;height:27px;font-size:18px}.preview-dock{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 4px 0;max-width:100%}.preview-context{font-size:10px;color:#afb4bb;white-space:nowrap;flex:none}
@media(prefers-color-scheme:dark){body{background:#1c1d20;color:#dcdee2}.preview-sidebar{background:#191a1d;border-color:#27292d}.preview-session{background:#25272c}.preview-header{border-color:#292b30}.preview-demo{border-color:#373a40;color:#8e939e}.preview-user{background:#2a2c31}.preview-answer{color:#d3d5da}.preview-composer{background:#24262b;border-color:#34373e;box-shadow:0 2px 12px #00000012}.preview-toolbar button{background:#373d39;color:#7f8f84}.preview-context{color:#707681}.preview-editor:empty:before{color:#777e8a}.preview-sidebar button:hover{background:#ffffff06}}
@media(max-width:700px){.preview-sidebar{display:none}.preview-header{padding:0 18px;height:52px}.preview-chat{padding:0 14px 16px}.preview-conversation{padding-top:56px}.preview-answer{font-size:13px;padding-top:28px}.preview-toolbar{gap:12px;font-size:10px}.preview-context{font-size:9px}}
</style>`);
const mount = document.createElement('div'); document.body.append(mount); createRoot(mount).render(<Fixture />);
