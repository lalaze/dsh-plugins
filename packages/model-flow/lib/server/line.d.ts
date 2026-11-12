/** The text after `/flow`. */
import type { Role } from './routes.js';
export declare const DEFAULT_ROUNDS = 3;
export declare const MAX_ROUNDS = 10;
/**
 * `worktree` says where the flow runs when the line says so: in a worktree of its own (true) or in this conversation
 * (false). `repo` and `branch` only mean something for a worktree.
 */
export type FlowLine = {
    kind: 'status';
} | {
    kind: 'stop';
} | {
    kind: 'run';
    goal: string;
    overrides: Partial<Record<Role, string>>;
    rounds?: number;
    worktree?: boolean;
    repo?: string;
    branch?: string;
};
export declare const USAGE = "/flow [plan=model] [impl=model] [review=model] [rounds=n] [wt=on|off] <goal>";
export declare function parseLine(raw: string, hasAttachments?: boolean): FlowLine;
