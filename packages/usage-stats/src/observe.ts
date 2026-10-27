import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { validUsage, type UsageRecord } from './domain.js';

/** Observe one public stream call. Usage chunks replace prior snapshots, as in DSH's accumulator. */
export async function* observe(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, save: (record: UsageRecord) => Promise<void>, warn: (error: unknown) => void, workspace?: string): AsyncIterable<StreamChunk> {
  const id = randomUUID(); const startedAt = new Date().toISOString(); const start = performance.now();
  const identity = { provider: options.provider, model: options.model, sessionId: options.sessionId, purpose: options.purpose ?? 'conversation', ...(workspace ? { workspace } : {}) };
  let usage: TokenUsage | undefined; let status: UsageRecord['status'] = 'cancelled';
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage' && validUsage(chunk.usage)) usage = structuredClone(chunk.usage);
      if (chunk.type === 'finish') status = chunk.reason.kind === 'error' ? 'error' : chunk.reason.kind === 'aborted' ? 'cancelled' : 'completed';
      yield chunk;
    }
  } catch (error) { status = options.signal?.aborted ? 'cancelled' : 'error'; throw error; }
  finally {
    try { await save({ id, startedAt, ...identity, status, durationMs: Math.max(0, performance.now() - start), usage }); }
    catch (error) { try { warn(error); } catch { /* Diagnostics must not break model calls. */ } }
  }
}
