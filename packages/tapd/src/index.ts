import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { publicSettings, SettingsStore } from './settings.js';
import { tapdSource, type Autofix } from './source.js';
import { TapdClient } from './tapd.js';

export const name = 'dsh-tapd';
export const inject = ['connection'];
export const API_PATH = '/api/tapd';
const settingsFile = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name, 'settings.json');

export async function apply(ctx: Context): Promise<void> {
  const store = new SettingsStore(settingsFile());
  await store.open();
  const client = new TapdClient(() => store.settings), source = tapdSource(client, () => store.settings);
  // Whenever dsh-autofix is there, TAPD is one of its sources; when it reloads, TAPD registers again.
  let connected = false;
  (ctx as unknown as { inject(names: string[], callback: (scoped: Context & { autofix: Autofix; effect(run: () => () => void): void }) => void): void }).inject(['autofix'], scoped => {
    const remove = scoped.autofix.register(source);
    connected = true;
    scoped.effect(() => () => { connected = false; remove(); });
  });
  const state = () => ({ settings: publicSettings(store.settings), connected });
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.headers.get('X-DSH-Tapd') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Use the TAPD settings.' }, { status: 403, headers });
      const input = await request.json() as Record<string, unknown>;
      if (input.action === 'save') await store.save(input.settings);
      else if (input.action === 'test') return Response.json({ ...state(), found: (await client.listBugs(request.signal)).length }, { headers });
      else if (input.action !== 'state') return Response.json({ error: 'Unknown action' }, { status: 400, headers });
      return Response.json(state(), { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Request failed', ...state() }, { status: 400, headers });
    }
  } });
}
