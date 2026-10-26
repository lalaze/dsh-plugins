import type { Model, Task } from './domain.js';
export declare const ANTIGRAVITY_NOTICE = "Antigravity headless mode denies operations that require interactive approval. Configure permissions in agy before running tasks.";
export declare function decodeAntigravityModels(output: string): Model[];
export declare function antigravityArguments(command: string, task: Task, resume: boolean): string[];
/** Runs on the SSH host. Owns only its child CLI and forwards native JSONL unchanged. */
export declare const ANTIGRAVITY_RUNNER: string;
