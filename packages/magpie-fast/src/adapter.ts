import { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { FetchFunction, Provider, ProviderRequestOptions, ProviderStreams } from '@earendil-works/pi-ai';
import { LlmError, LlmRuntime, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { materializeModels } from './models.js';
import { isGpt, record, type Protocol, type SourceProvider } from './config.js';

// Resolve public pi-ai entry points from the adapter that owns the runtime dependency.
// A profile need not install another copy of pi-ai or its unrelated provider SDKs.
const hostModule = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai');
async function providerApi(protocol: Protocol): Promise<ProviderStreams> {
  const manifestPath = findPackageJSON('@earendil-works/pi-ai', hostModule);
  const manifest = manifestPath ? record(JSON.parse(await readFile(manifestPath, 'utf8'))) : undefined;
  const exports = record(manifest?.exports);
  const entry = exports?.[`./api/${protocol}`] ?? exports?.['./api/*'];
  const target = typeof entry === 'string' ? entry : record(entry)?.import ?? record(entry)?.default;
  if (!manifestPath || typeof target !== 'string' || !target.startsWith('./')) {
    throw new LlmError("The pi-ai bundled with DSH lacks the required OpenAI API entry point. Update DSH", 'UNSUPPORTED_HOST_RUNTIME');
  }
  // pi-ai's public export map is ESM-only; require.resolve cannot select it.
  return import(new URL(target.replaceAll('*', protocol), pathToFileURL(manifestPath)).href);
}

export function requestOptions(options: ProviderRequestOptions | undefined, model: string, fetch?: FetchFunction): ProviderRequestOptions {
  return { ...options, ...(fetch ? { fetch } : {}), onPayload: async (body, info) => {
    const prepared = (await options?.onPayload?.(body, info)) ?? body;
    const object = record(prepared);
    return isGpt(model) && object ? { ...object, service_tier: 'priority' } : prepared;
  } };
}
interface FastPoolOptions {
  context: Context;
  resolveKey: (source: SourceProvider) => Promise<string>;
  resolveAttachments?: PiAiAdapterOptions['resolveAttachments'];
  resolveImageAccess?: PiAiAdapterOptions['resolveImageAccess'];
  fetch?: FetchFunction;
}
interface Generation { scope: Context; runtime: LlmRuntime; active: number; retired: boolean }

/** Private runtimes retain DSH's file/image/tool projections and error boundary.
 * They never register providers in the application's model directory or recurse into its middleware.
 */
export class FastPool {
  private readonly entries = new Map<string, Generation>();
  private closed = false;
  constructor(private readonly options: FastPoolOptions) {}

  private async generation(source: SourceProvider): Promise<Generation> {
    const captured = structuredClone(source);
    const key = await this.options.resolveKey(captured);
    const signature = JSON.stringify([captured, key]);
    const existing = this.entries.get(signature);
    if (existing) { this.entries.delete(signature); this.entries.set(signature, existing); return existing; }
    const { models, caps } = materializeModels(captured);
    const api = await providerApi(captured.profile.api === 'openai-responses' ? 'openai-responses' : 'openai-completions');
    const provider: Provider<Protocol> = {
      id: captured.id, name: captured.profile.displayName ?? captured.id, baseUrl: captured.profile.baseURL,
      auth: { apiKey: { name: 'Gateway API key', resolve: async () => ({ auth: { apiKey: key } }) } },
      getModels: () => models,
      stream: (model, context, options) => api.stream(model, context, { ...options, ...requestOptions(options, model.id, this.options.fetch) }),
      streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, ...requestOptions(options, model.id, this.options.fetch) }),
    };
    const profile: ResolvedPiAiProviderProfile = {
      ...captured.profile, provider: captured.id, displayName: provider.name,
      apiKeyEnv: captured.profile.apiKeyEnv ? credentialRef(captured.profile.apiKeyEnv) : undefined,
      piProvider: provider, modelErrors: new Map(), configuredMaxTokens: caps,
      retryPolicy: resolveRetryPolicy(captured.profile.retryPolicy, 'dsh-magpie-fast'),
      streamIdleTimeoutMs: captured.profile.streamIdleTimeoutMs ?? 300000,
      maxRequestImageBytes: captured.profile.maxRequestImageBytes ?? 20971520,
      requestImagePixelBudget: captured.profile.requestImagePixelBudget ?? 4194304,
      requestImageMaxBytes: captured.profile.requestImageMaxBytes ?? 1048576,
    };
    const profiles = new Map([[captured.id, profile]]);
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: async () => key,
      auth: {
        credentials: { read: async () => undefined, list: async () => [], delete: async () => {}, modify: async () => { throw new Error('Gateway credentials are read-only'); } },
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
      resolveAttachments: this.options.resolveAttachments, resolveImageAccess: this.options.resolveImageAccess,
    });
    const scope = new Context();
    for (const service of ['attachments', 'fs']) {
      const value = this.options.context.get(service);
      if (value) scope.provide(service, value);
    }
    await scope.plugin(LlmRuntime);
    scope.llm.registerAdapter([captured.id], adapter);
    const generation: Generation = { scope, runtime: scope.llm, active: 0, retired: this.closed };
    if (!this.closed) this.entries.set(signature, generation);
    while (this.entries.size > 8) {
      const [oldKey, old] = this.entries.entries().next().value!;
      this.entries.delete(oldKey); this.retire(old);
    }
    return generation;
  }
  private retire(entry: Generation) { entry.retired = true; if (!entry.active) void entry.scope.fiber.dispose(); }
  close() { this.closed = true; for (const entry of this.entries.values()) this.retire(entry); this.entries.clear(); }

  async *stream(source: SourceProvider, request: GenerateOptions): AsyncIterable<StreamChunk> {
    let generation: Generation | undefined;
    try {
      request.signal?.throwIfAborted();
      generation = await this.generation(source); generation.active++;
      request.signal?.throwIfAborted();
      yield* generation.runtime.stream(request);
    } catch (error) {
      const failure = error && typeof error === 'object' && 'failure' in error ? error.failure : undefined;
      yield { type: 'finish', reason: {
        kind: request.signal?.aborted ? 'aborted' : 'error',
        failure: record(failure) && typeof record(failure)?.code === 'string'
          ? failure as { code: string; message: string }
          : { code: request.signal?.aborted ? 'ABORTED' : 'MAGPIE_FAST_ERROR', message: request.signal?.aborted ? "Request cancelled" : "Could not prepare the GPT Fast request. Check the provider settings and gateway credentials" },
      } };
    } finally {
      if (generation) { generation.active--; if (!generation.active && generation.retired) void generation.scope.fiber.dispose(); }
    }
  }
}
