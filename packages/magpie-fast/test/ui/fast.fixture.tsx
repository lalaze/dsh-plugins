import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client/index.js';
import type { Selection } from '../../src/gpt.js';

const MODEL = 'codex/gpt-6.1-sol';
let snapshot = { current: { provider: 'remote-magpie', model: MODEL } as Selection | null };
const listeners = new Set<() => void>();
const store = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
let Control!: React.FC<{ sessionId?: string }>;
const locale = createLocaleFixture();
const fixture = { setLocale: locale.setLocale,
  failRead: false, failWrite: false, requestCount: 0, slot: {} as Record<string, unknown>,
  setModel(selection: Selection) { snapshot = { current: selection }; for (const listener of listeners) listener(); },
};
Object.assign(window, { fixture });
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (String(input).startsWith('/api/magpie-fast')) {
    fixture.requestCount++;
    if ((init?.method === 'POST' && fixture.failWrite) || (!init?.method && fixture.failRead)) return Promise.resolve(new Response('{}', { status: 500 }));
  }
  return originalFetch(input, init);
};
apply({ get: () => locale, effect: setup => { setup(); }, slots: {
  inject: (_name, factory) => factory(),
  register: (spec, component) => { fixture.slot = spec; Control = component; },
}, modelDirectories: { directoryFor: () => ({ store }) } });

function Fixture() {
  const [sessionId, setSessionId] = useState('session-a');
  const [model, setModel] = useState('gpt');
  return <main>
    <h1>GPT Fast</h1><p>会话中的闪电开关</p>
    <div className="fixture-options">
      <label>会话 <select aria-label="会话" value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="session-a">会话 A</option><option value="session-b">会话 B</option></select></label>
      <label>模型 <select aria-label="模型" value={model} onChange={e => {
        const value = e.target.value; setModel(value);
        fixture.setModel({ provider: value === 'unsupported' ? 'codex-cli' : 'remote-magpie', model: value === 'claude' ? 'claude/opus' : MODEL });
      }}><option value="gpt">GPT-6.1-Sol</option><option value="claude">Claude Opus</option><option value="unsupported">GPT（非 API 提供商）</option></select></label>
    </div>
    <div className="fixture-card" data-composer-card>
      <div contentEditable suppressContentEditableWarning role="textbox" aria-label="消息" className="fixture-editor">帮我检查一下这个项目</div>
      <div className="fixture-toolbar">
        <span className="fixture-plus" aria-hidden="true">＋</span>
        <span className="fixture-model">◎ {model === 'claude' ? 'Claude Opus' : 'GPT-6.1-Sol'}⌄</span>
        <span>♧ Max⌄</span><span className="fixture-permission">♙ Auto-review⌄</span>
        <Control sessionId={sessionId} />
        <span aria-label="任务列表" className="fixture-list">☷</span>
        <span className="fixture-collaborate">♧ 协作⌄</span>
      </div>
    </div>
    <p className="fixture-note">闪电点亮表示已为本会话启用 Fast；切换到非 GPT 模型后自动隐藏。</p>
  </main>;
}
document.head.insertAdjacentHTML('beforeend', `<style>
:root{color-scheme:light dark;--dsw-alias-label-secondary:#666;--dsw-alias-interactive-bg-hover:#0000000b;--dsw-alias-state-warn-label:#ac7100;--dsw-alias-label-primary:#222;--dsw-alias-bg-elevated:#fff}*{box-sizing:border-box}body{margin:0;background:#f6f6f6;color:#222;font:14px/1.5 system-ui}main{max-width:840px;padding:44px 28px;margin:0 auto}h1{font-size:23px;margin:0}p{color:#888;margin:6px 0 26px}.fixture-options{display:flex;gap:20px;margin:0 0 24px}.fixture-options select{font:inherit;padding:4px;border-radius:5px}.fixture-card{background:#fff;border:1px solid #e8e8e8;border-radius:20px;padding:20px 16px 12px}.fixture-editor{min-height:80px;padding:0 9px;outline:none}.fixture-toolbar{display:flex;align-items:center;gap:16px;color:#888;font-size:13px;white-space:nowrap;min-height:30px}.fixture-plus{font-size:19px;margin:0 0 0 1px}.fixture-model{min-width:0}.fixture-list{font-size:20px}.fixture-collaborate{margin-left:auto}.fixture-note{font-size:12px;margin-top:18px}
@media(prefers-color-scheme:dark){:root{--dsw-alias-label-secondary:#a0a0a0;--dsw-alias-interactive-bg-hover:#ffffff0c;--dsw-alias-state-warn-label:#efb642;--dsw-alias-label-primary:#eee;--dsw-alias-bg-elevated:#303030}body{background:#202020;color:#eee}.fixture-card{background:#171717;border-color:#292929}.fixture-toolbar{color:#999}}
@media(max-width:600px){main{padding:28px 12px}.fixture-toolbar{gap:8px;flex-wrap:wrap}.fixture-collaborate{display:none}.fixture-options{gap:12px;flex-wrap:wrap}.fixture-card{padding:16px 10px 10px}}
</style>`);
const root = document.createElement('div'); document.body.append(root); createRoot(root).render(<Fixture />);
