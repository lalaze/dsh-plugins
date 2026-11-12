import { type ItemImage, type Message, type Route, type Task } from './domain.js';
import type { Handed } from './command.js';
import type { FixLine } from './fixline.js';
import type { State } from './service.js';
import type { Store } from './store.js';
import { type RunChoice } from './tasks.js';
import type { Machine, ProjectDetail } from './workplaces.js';
type TaskView = State['tasks'][number];
export interface ServedRoute {
    id: string;
    name: string;
    repository: string;
    defaultBranch: string;
    accept: Route['accept'];
}
/** What the DSH that runs fixes says about itself on a machine; `at` is when it last did. */
export interface Published {
    executor: string;
    name: string;
    at: number;
    routes: ServedRoute[];
}
export type RelayRequest = {
    id: string;
    kind: 'file';
    routeId: string;
    branch: string;
    title: string;
    body: string;
    pictures: string[];
    feature?: boolean;
    models?: RunChoice['models'];
    rounds?: number;
} | {
    id: string;
    kind: 'sendBack';
    key: string;
    feedback: string;
    pictures: string[];
} | {
    id: string;
    kind: 'accept' | 'stop' | 'retryReport' | 'removeWorkspace';
    key: string;
};
type Ask = RelayRequest extends infer R ? R extends {
    id: string;
} ? Omit<R, 'id' | 'pictures'> : never : never;
export type RelayDone = {
    ok: true;
    key?: string;
    ref?: string;
    title?: string;
} | {
    ok: false;
    said: Message;
};
export interface RemoteTask {
    task: TaskView;
    route: Pick<Route, 'id' | 'name' | 'accept'>;
}
export interface Diff {
    stat: string;
    patch: string;
    truncated: boolean;
}
export interface ServerHost {
    store: Store;
    machine(project: string): Promise<Machine>;
    inspect(project: string): Promise<ProjectDetail>;
    createManual(input: {
        title: string;
        body: string;
        images: {
            name: string;
            mediaType: string;
            data: string;
        }[];
        assignment: {
            routeId: string;
            branch: string;
        };
        kind?: 'feature';
    }): Promise<{
        key: string;
    }>;
    view(key: string): TaskView | undefined;
    diff(key: string): Promise<Diff>;
    tasks: {
        start(key: string, pictures?: readonly unknown[], choice?: RunChoice): Promise<Task>;
        sendBack(key: string, feedback: string, pictures?: readonly ItemImage[]): Promise<Task>;
        accept(key: string): Promise<Task>;
        stop(key: string): boolean;
        retryReport(key: string): Promise<Task>;
        removeWorkspace(key: string): Promise<Task>;
    };
    /** This DSH, as other DSHes will name it. */
    identity: {
        id: string;
        name: string;
    };
    now?(): number;
    root?: string;
}
/** The side that runs fixes. Nothing happens unless the settings say other DSHes may hand bugs in. */
export declare class RelayServer {
    private readonly host;
    private timer;
    private running;
    private stopped;
    private readonly repositories;
    private readonly beats;
    private readonly published;
    /** For the settings page: the machines served, and what went wrong on the last round. */
    status: {
        label: string;
        routes: string[];
        error?: string;
    }[];
    constructor(host: ServerHost);
    private now;
    /** Often enough that a person who typed /fix is answered at once, seldom enough to be nothing to the machine. */
    start(everyMs?: number): void;
    stop(): void;
    /** One round on every machine that holds a repository of the settings. A machine that fails does not stop the others. */
    tick(): Promise<void>;
    private serve;
    /** A request is another computer's word: checked like anything typed into a page. */
    private handle;
    /** Each task of these repositories as it is now, written when it changed; a fix that waits for a person comes with its changes. */
    private publish;
}
export interface ClientHost {
    machine(folder: string): Promise<Machine>;
    inspect(folder: string): Promise<ProjectDetail>;
    /** A picture DSH keeps, as its bytes. */
    readImage(ref: unknown): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    now?(): number;
    root?: string;
    /** How long to wait for the other DSH to take a request. */
    waitMs?: number;
    pollMs?: number;
}
/** The side a person types into, when the repository is another DSH's to fix. `folder` is always a workspace of this DSH. */
export declare class RelayClient {
    private readonly host;
    constructor(host: ClientHost);
    private now;
    private spool;
    /** Hands a bug typed in a conversation to the DSH that runs fixes for that folder's machine. Undefined when there is none. */
    file(folder: string, line: FixLine, pictures: readonly unknown[], how?: Handed): Promise<{
        key: string;
        ref: string;
        title: string;
    } | undefined>;
    /** Something a person decided about a task the other DSH runs. */
    act(folder: string, ask: Ask, pictures?: readonly ItemImage[]): Promise<void>;
    task(folder: string, key: string): Promise<RemoteTask | undefined>;
    diff(folder: string, key: string): Promise<Diff>;
    /** The pictures first, the request last, so the other DSH never finds one without the other; then its answer. */
    private send;
}
export {};
