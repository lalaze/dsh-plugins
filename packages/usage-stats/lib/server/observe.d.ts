import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type UsageRecord } from './domain.js';
/** Observe one public stream call. Usage chunks replace prior snapshots, as in DSH's accumulator. */
export declare function observe(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, save: (record: UsageRecord) => Promise<void>, warn: (error: unknown) => void): AsyncIterable<StreamChunk>;
