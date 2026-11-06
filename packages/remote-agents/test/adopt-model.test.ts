import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptModel } from '../src/chat/adopt-model.js';

function host(rows: { sessionId: string; blank?: boolean }[]) {
  const calls: unknown[][] = [];
  let current = { provider: 'remote-cli-claude', model: 'machine/claude/opus' };
  const services: Record<string, unknown> = {
    sessionController: {
      list: async () => ({ items: rows }),
      // As DSH does: choosing a model for a conversation also makes it the default.
      selectModel: async (request: { sessionId: string; provider: string; model: string }) => {
        calls.push(['select', request]);
        current = { provider: request.provider, model: request.model };
      },
    },
    agentDefaultModel: {
      currentSelection: () => current,
      saveSelection: async (next: typeof current) => { calls.push(['save', next]); current = next; },
    },
  };
  return { get: (name: string) => services[name], calls, services, current: () => current };
}
const local = { provider: 'deepseek', model: 'deepseek-chat' };

test('a new conversation gets the model, and the default stays what the user chose elsewhere', async () => {
  const h = host([{ sessionId: 's1', blank: true }]);
  await adoptModel(h.get)('s1', local);
  assert.deepEqual(h.calls[0], ['select', { sessionId: 's1', ...local }]);
  assert.deepEqual(h.current(), { provider: 'remote-cli-claude', model: 'machine/claude/opus' });
});

test('a conversation that has started keeps its model', async () => {
  const h = host([{ sessionId: 's1', blank: false }]);
  await assert.rejects(adoptModel(h.get)('s1', local), /already started/);
  await assert.rejects(adoptModel(h.get)('unknown', local), /already started/);
  assert.deepEqual(h.calls, []);
});

test('a DSH without these services says so', async () => {
  await assert.rejects(adoptModel(() => undefined)('s1', local), /not available/);
});
