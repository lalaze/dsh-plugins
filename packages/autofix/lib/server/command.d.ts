import { type Task } from './domain.js';
import { type FixLine } from './fixline.js';
import type { ManualInput } from './manual.js';
import { COMMAND } from './shared.js';
export { COMMAND };
import type { Store } from './store.js';
import type { RunChoice } from './tasks.js';
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
        start(key: string, pictures?: readonly unknown[], choice?: RunChoice): Promise<Task>;
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
    /** Names a conversation that had nothing in it before the line was typed there, so it is not left untitled. */
    title?(agent: LiveAgent, title: string): Promise<void>;
    /** Another DSH that runs fixes for the machine a folder is on: hands the bug to it, or answers undefined when there is none. */
    handOver?(folder: string, line: FixLine, pictures: readonly unknown[], how?: Handed): Promise<{
        key: string;
        ref: string;
        title: string;
    } | undefined>;
    now?(): number;
}
/** What goes with a task to the DSH that runs it. */
export type Handed = RunChoice & {
    kind?: 'feature';
};
/**
 * A task that did not come from a typed /fix: /flow hands in something to build, with where it goes and what it runs
 * with already read from its own line.
 */
export interface TakeOptions extends Handed {
    repo?: string;
    branch?: string;
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
    /**
     * What was typed becomes a task in the repository the conversation works in, and the row that follows it. `options`
     * are for a task another plugin hands in (/flow in a worktree of its own): what kind it is, and what its line chose.
     */
    take(agent: LiveAgent, text: string, attachments?: readonly {
        type: string;
        attachment?: unknown;
    }[], options?: TakeOptions): Promise<RowResult>;
    /** The repository a bug typed here belongs to: the one named, or the one this conversation works in. */
    private route;
}
