import type { Context } from '@deepseek-ai/cordis';
import type { Sharing } from './sharing.js';
/** Shared MCP calls run through DSH's tool pipeline with the owning conversation's agent; skills come from its registry. */
export declare function installSharingHost(ctx: Context, sharing: Sharing): void;
