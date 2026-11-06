/** The text after `/flow`. */
import type { Role } from './routes.js';
export declare const DEFAULT_ROUNDS = 3;
export declare const MAX_ROUNDS = 10;
export type FlowLine = {
    kind: 'status';
} | {
    kind: 'stop';
} | {
    kind: 'run';
    goal: string;
    overrides: Partial<Record<Role, string>>;
    rounds?: number;
};
export declare function parseLine(raw: string, hasAttachments?: boolean): FlowLine;
