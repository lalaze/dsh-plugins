import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-settings';
import { credentialRef, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { Config, NAME, gatewayURL, localSource, readSources, type PluginConfig, type Source } from './config.js';
import { QuotaError, QuotaService, type ResolvedSource } from './service.js';
import { record } from './normalize.js';

export { Config };
export const name = NAME;
export const inject = ['connection', 'settings'];

export async function resolveHeaders(ctx: Context, source: Source): Promise<Headers> {
  const headers = new Headers(source.profile.headers);
  headers.set('Accept', 'application/json'); headers.set('User-Agent', 'dsh-magpie-quota/0.1.0');
  // Explicit vendor headers have the same authority as the provider's own requests.
  if (headers.has('authorization') || headers.has('x-api-key')) return headers;
  const credentials = ctx.get('credentials');
  let key: string | undefined;
  if (source.profile.apiKeyEnv) {
    const ref = credentialRef(source.profile.apiKeyEnv);
    key = credentials ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
    if (!key?.trim()) throw new QuotaError('MISSING_CREDENTIAL', "Missing Magpie gateway credential. Check the provider's credentials", 400);
  } else if (credentials && isCredentialKeySegment(source.id)) {
    const stored = await credentials.readRecord(recordKeyFor(source.id));
    if (stored?.kind === 'api-key') key = stored.key;
  }
  if (!key?.trim()) {
    if (['localhost', '127.0.0.1', '[::1]'].includes(gatewayURL(source.profile.baseURL, 'quotas').hostname)) key = 'magpie-dsh';
    else throw new QuotaError('MISSING_CREDENTIAL', "Remote Magpie requires an existing provider's gateway credentials", 400);
  }
  if (/[\r\n]/.test(key)) throw new QuotaError('MISSING_CREDENTIAL', "Invalid Magpie gateway credential format", 400);
  headers.set('Authorization', `Bearer ${key.trim()}`);
  return headers;
}

export function apply(ctx: Context, config: PluginConfig = {}, dependencies: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): void {
  const sources = async (): Promise<ResolvedSource[]> => {
    let candidates = readSources(ctx.settings.describe(), config);
    if (!candidates.length && !config.providers?.length && !config.baseURL && config.discoverLocal !== false) candidates = [await localSource()];
    return Promise.all(candidates.map(async source => {
      try { gatewayURL(source.profile.baseURL, 'quotas'); return { ...source, headers: await resolveHeaders(ctx, source) }; }
      catch (e) { return { ...source, headers: new Headers(), error: e instanceof QuotaError ? e : new QuotaError('INVALID_CONFIG', "Invalid Magpie provider URL or credential settings", 400) }; }
    }));
  };
  const service = new QuotaService({ sources, cacheSeconds: config.cacheSeconds, ...dependencies });
  ctx.effect(() => () => service.close());
  ctx.connection.fetch.register({ path: '/api/magpie-quota', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    try {
      if (request.method === 'POST') {
        const text = await request.text();
        if (text.length > 8192) throw new QuotaError('INVALID_REQUEST', "Refresh request is too large", 400);
        let body: Record<string, unknown> | undefined;
        try { body = record(JSON.parse(text)); } catch { /* validated below */ }
        if (typeof body?.gatewayId !== 'string' || typeof body.accountId !== 'string' || !body.gatewayId || !body.accountId) throw new QuotaError('INVALID_REQUEST', "Specify an account to refresh", 400);
        return Response.json(await service.refresh(body.gatewayId, body.accountId), { headers });
      }
      return Response.json(await service.report(new URL(request.url).searchParams.get('reload') === '1'), { headers });
    } catch (error) {
      const e = error instanceof QuotaError ? error : new QuotaError('INTERNAL_ERROR', "Could not read quota right now. Try again", 500);
      if (e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
      return Response.json({ error: e.message, code: e.code, retryAfter: e.retryAfter }, { status: e.status, headers });
    }
  } });
}
