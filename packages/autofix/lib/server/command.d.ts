import { type Task } from './domain.js';
import { type FixLine } from './fixline.js';
import type { ManualInput } from './manual.js';
import { COMMAND } from './shared.js';
export { COMMAND };
import type { Store } from './store.js';
import type { ProjectDetail } from './workplaces.js';
export type RowResult = {
    kind: 'success' | 'error';
    text: string;
};
/** A conversation's live agent, as far as this command reads it. */
export interface LiveAgent {
    id: string;
    phase?: {
        kind?: string;
        lastTurn?: number;
    };
    session: {
        append(type: string, payload: unknown): unknown;
        deriveMessages?(): unknown[];
    };
}
export interface Invocation {
    agent: LiveAgent;
    rawInput: string;
    attachments?: readonly {
        type: string;
        attachment?: unknown;
    }[];
}
export interface CommandHost {
    store: Store;
    tasks: {
        start(key: string, pictures?: readonly unknown[]): Promise<Task>;
        sendBack(key: string, feedback: string, pictures?: readonly never[], kept?: readonly unknown[]): Promise<Task>;
    };
    createManual(input: ManualInput & {
        assignment: {
            routeId: string;
            branch: string;
        };
    }): Promise<{
        key: string;
    }>;
    inspect(project: string): Promise<ProjectDetail>;
    /** The folder a conversation works in, when DSH can say. */
    folder(agent: LiveAgent): string | undefined;
    /** Another DSH that runs fixes for the machine a folder is on: hands the bug to it, or answers undefined when there is none. */
    handOver?(folder: string, line: FixLine, pictures: readonly unknown[]): Promise<{
        key: string;
        ref: string;
        title: string;
    } | undefined>;
    now?(): number;
}
export declare class FixCommand {
    private readonly host;
    /** Only this process knows the mark, so a card cannot be forged by typing. */
    private readonly mark;
    private last;
    constructor(host: CommandHost);
    private now;
    /** The line that puts card number `card` of a task into a conversation. */
    cardLine(key: string, card: number): string;
    /** The conversation that took the newest typed /fix: the new-conversation page does not open it by itself. */
    lastCommand(maxAge: number): string | undefined;
    private row;
    handle({ agent, rawInput, attachments }: Invocation): Promise<RowResult>;
    /** The repository a bug typed here belongs to: the one named, or the one this conversation works in. */
    private route;
}
