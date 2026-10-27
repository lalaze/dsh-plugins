import { installLocale } from '../../src/client/i18n.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from '../../src/client/index.js';
import { parseQuery, report, toCsv, type UsageRecord } from '../../src/domain.js';

const locale = createLocaleFixture();
installLocale({ get: () => locale });
const fixture = { setLocale: locale.setLocale, fail: false, empty: false, demo: location.hash === '#demo', workspaces: false, requests: [] as string[] };
Object.assign(window, { fixture });
const records: UsageRecord[] = [
  { id: 'local', provider: 'deepseek', model: 'deepseek-chat', sessionId: 'local-session', purpose: 'conversation', startedAt: '2026-10-21T12:00:00.000Z', durationMs: 100, status: 'completed', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } },
  { id: 'remote', provider: 'claude-ssh-dev', model: 'sonnet', sessionId: 'remote-session', purpose: 'conversation', startedAt: '2026-10-20T12:00:00.000Z', durationMs: 200, status: 'completed', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 11 } },
  { id: 'error', provider: 'claude-ssh-dev', model: 'opus', sessionId: 'remote-session', purpose: 'conversation', startedAt: '2026-10-21T13:00:00.000Z', durationMs: 20, status: 'error' },
];
const demoRecords: UsageRecord[] = Array.from({ length: 21 }, (_, day) => {
  const startedAt = new Date(Date.now() - (20 - day) * 86_400_000).toISOString().slice(0, 10) + 'T12:00:00.000Z';
  return ['deepseek', 'claude-ssh-dev', 'claude-ssh-dev', 'remote-cli-codex'].flatMap((provider, modelIndex) => Array.from({ length: 3 + (day * 7 + modelIndex * 3) % 14 }, (_, call) => ({
    id: `demo-${day}-${modelIndex}-${call}`, startedAt, provider, model: ['deepseek-chat', 'sonnet', 'opus', 'gpt-5.5'][modelIndex], sessionId: `session-${modelIndex}`,
    ...(modelIndex ? { host: ['', 'gpu-box', 'gpu-box', 'build-server'][modelIndex], workspace: ['', '/srv/projects/api', '/home/dev/projects/web-app', '/srv/projects/api'][modelIndex] } : { workspace: '/Users/me/notes' }), purpose: 'conversation', durationMs: 3000,
    status: day === 18 && call === 2 ? 'error' as const : 'completed' as const,
    usage: { inputTokens: (2400 + day * 130 + call * 250) * (modelIndex + 1), outputTokens: 600 + call * 80, cacheReadTokens: 10000 + (day * 1600 + call * 370) % 26000, cacheWriteTokens: 1500 + call * 120 },
  })));
}).flat();
/** One record per workspace: enough groups to page the details table. */
const workspaceRecords: UsageRecord[] = Array.from({ length: 21 }, (_, i) => ({ ...records[0], id: `workspace-${i}`, workspace: `/srv/projects/w${String(i).padStart(2, '0')}` }));
window.fetch = async input => {
  const url = new URL(String(input), 'http://fixture.test'); fixture.requests.push(url.href);
  if (fixture.fail) return Response.json({ error: '模拟网络错误' }, { status: 503 });
  const data = report(fixture.empty ? [] : fixture.demo ? demoRecords : fixture.workspaces ? workspaceRecords : records, parseQuery(url));
  if (url.searchParams.get('format') === 'csv') return new Response(toCsv(data), { headers: { 'Content-Type': 'text/csv' } });
  return Response.json(data);
};
const root = document.createElement('div'); document.body.append(root);
if (fixture.demo) { const banner = document.createElement('div'); banner.textContent = '界面预览 · 以下为演示数据'; banner.style.cssText = 'padding:8px;text-align:center;font:11px system-ui;opacity:.5'; document.body.prepend(banner); }
createRoot(root).render(<Dashboard />);
