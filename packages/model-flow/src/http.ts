/** Settings data: the models to choose from, their thinking levels, and saving the choice. */
import type { CatalogModel } from './routes.js';
import { API_PATH, type EffortOption, type Locale } from './shared.js';
import { configFrom, type FlowStore } from './store.js';

export { API_PATH };
const LAST_COMMAND_AGE = 8000;
export interface SettingsHost {
  catalog(): Promise<CatalogModel[]>;
  efforts(provider: string, model: string): Promise<EffortOption[]>;
  /** The conversation of a /flow typed within the last `maxAge` milliseconds. */
  lastCommand(maxAge: number): string | undefined;
  setLocale(locale: Locale): void;
}
export function createHandler(store: FlowStore, host: SettingsHost) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method === 'GET') return Response.json({ config: store.config, models: await host.catalog() }, { headers });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (request.headers.get('X-DSH-Model-Flow') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Use the settings page.' }, { status: 403, headers });
      const input = await request.json() as { action?: unknown; config?: unknown; provider?: unknown; model?: unknown; locale?: unknown };
      if (input.action === 'lastCommand') return Response.json({ sessionId: host.lastCommand(LAST_COMMAND_AGE) ?? null }, { headers });
      if (input.action === 'locale') { host.setLocale(input.locale === 'zh' ? 'zh' : 'en'); return Response.json({}, { headers }); }
      if (input.action === 'save') {
        await store.save(configFrom(input.config));
        return Response.json({ config: store.config }, { headers });
      }
      if (input.action === 'efforts' && typeof input.provider === 'string' && typeof input.model === 'string') {
        return Response.json({ efforts: await host.efforts(input.provider, input.model) }, { headers });
      }
      return Response.json({ error: 'Unknown action' }, { status: 400, headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 500, headers });
    }
  };
}
