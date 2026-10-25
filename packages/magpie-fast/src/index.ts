import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-client-connection';
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { credentialRef, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import type {} from '@deepseek-ai/dsh-settings';
import { join } from 'node:path';
import { FastPool } from './adapter.js';
import { Config, NAME, defaultStateDir, readSources, record, supportedSource, type SourceProvider, type PluginConfig } from './config.js';
import { acquirePreferences, validSessionId } from './preferences.js';

export { Config, FastPool };
export const name = NAME;
export const inject = ['llm', 'connection'];

export async function resolveGatewayKey(ctx: Context, source: SourceProvider): Promise<string> {
  const credentials = ctx.get('credentials');
  if (source.profile.apiKeyEnv) {
    const ref = credentialRef(source.profile.apiKeyEnv);
    const value = credentials ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
    if (!value) throw new LlmError(`Missing gateway credential ${source.profile.apiKeyEnv}. Check the current model provider's credentials`, 'MISSING_CREDENTIAL');
    return assertUsableApiKey(value, name, ref);
  }
  if (credentials && isCredentialKeySegment(source.id)) {
    const stored = await credentials.readRecord(recordKeyFor(source.id));
    if (stored?.kind === 'api-key' && stored.key) return assertUsableApiKey(stored.key, name, source.id);
  }
  if (Object.keys(source.profile.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) return 'magpie-dsh';
  const hostname = new URL(source.profile.baseURL!).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return 'magpie-dsh';
  throw new LlmError("Remote GPT Fast requires the current provider's gateway key. Configure apiKeyEnv first", 'MISSING_CREDENTIAL');
}

export async function apply(ctx: Context, config: PluginConfig = {}, dependencies: { fetch?: typeof globalThis.fetch } = {}) {
  const lease = acquirePreferences(join(config.stateDir ?? defaultStateDir(), 'preferences.json'));
  try {
    const preferences = await lease.ready;
    ctx.effect(() => lease.release);
    const sources = () => readSources(ctx.get('settings')?.describe() ?? []);
    const pool = new FastPool({ context: ctx, resolveKey: source => resolveGatewayKey(ctx, source), resolveAttachments: () => ctx.get('attachments'),
      fetch: dependencies.fetch,
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    });
    ctx.effect(() => () => pool.close());
    ctx.on('llm/stream', (options, next) => {
      const enabled = options.sessionId && preferences.get(options.sessionId, config.defaultEnabled ?? false);
      const source = enabled ? supportedSource(sources(), options.provider, options.model) : undefined;
      return source ? pool.stream(source, options) : next();
    }, { global: true });
    ctx.connection.fetch.register({ path: '/api/magpie-fast', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
      try {
        const url = new URL(request.url);
        let body: Record<string, unknown> | undefined;
        if (request.method === 'POST') {
          const text = await request.text();
          if (text.length > 4096) return Response.json({ error: "Request is too large" }, { status: 400 });
          try { body = record(JSON.parse(text)); } catch { return Response.json({ error: "Request must be JSON" }, { status: 400 }); }
        } else body = Object.fromEntries(url.searchParams);
        const sessionId = body?.sessionId;
        if (!validSessionId(sessionId) || typeof body?.provider !== 'string' || typeof body?.model !== 'string') return Response.json({ error: "Invalid session or model" }, { status: 400 });
        const supported = !!supportedSource(sources(), body.provider, body.model);
        if (request.method === 'POST') {
          if (typeof body.enabled !== 'boolean') return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
          if (!supported && body.enabled) return Response.json({ error: "This GPT provider does not support the toggle. Configure an OpenAI Chat/Responses API model" }, { status: 409 });
          await preferences.set(sessionId, body.enabled);
        }
        return Response.json({ enabled: preferences.get(sessionId, config.defaultEnabled ?? false), supported,
          reason: supported ? undefined : "Requires an existing OpenAI Chat/Responses API provider (remote Magpie supported)",
        }, { headers: { 'Cache-Control': 'no-store' } });
      } catch { return Response.json({ error: "Could not read or save the GPT Fast setting. Try again" }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
    } });
  } catch (error) { lease.release(); throw error; }
}
