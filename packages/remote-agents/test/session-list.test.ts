import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSummary } from '../src/core/domain.js';
import { projectName, sessionPriority, sessionView, visibleSession } from '../src/client/sessions/session-list.js';

const agent = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id: 'session-1', hostId: 'host-1', cwd: '/srv/project', provider: 'codex', model: 'model', modes: [], title: 'Test task',
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z', archived: false, delegated: false,
  started: true, attached: false, status: 'idle', pendingPermissions: 0, ...overrides,
});

test('saved and main-chat sessions stay in history; activity and errors remain visible in progress', () => {
  assert.equal(sessionView(agent()), 'history');
  assert.equal(sessionView(agent({ chatSessionId: 'main-chat' })), 'history');
  assert.equal(sessionView(agent({ status: 'closed', resumable: false })), 'history');
  for (const status of ['starting', 'running', 'attention', 'error'] as const) assert.equal(sessionView(agent({ status })), 'active');
  assert.equal(sessionView(agent({ pendingPermissions: 1 })), 'active');
  assert.equal(sessionView(agent({ archived: true })), 'archived');
  assert.equal(visibleSession(agent({ chatSessionId: 'remote-compaction-internal' })), false);
});

test('attention takes priority over running tasks and newer idle history', () => {
  const saved = agent({ id: 'saved', updatedAt: '2026-10-27T12:00:00Z' });
  const running = agent({ id: 'running', status: 'running' });
  const approval = agent({ id: 'approval', status: 'attention', pendingPermissions: 1 });
  assert.deepEqual([saved, running, approval].sort(sessionPriority).map(a => a.id), ['approval', 'running', 'saved']);
  assert.equal(projectName('/Volumes/data/code/dsh-plugins/'), 'dsh-plugins');
  assert.equal(projectName('C:\\code\\project\\'), 'project');
  assert.equal(projectName('/'), '/');
});
