/** The sources that hand bugs in, and what the board and the settings page can ask for. */
import { itemKey, messageOf, type Autofix, type Item, type Message, type PoolItem, type Settings, type Source, type Task } from './domain.js';
import { type ManualInput, type ManualSource } from './manual.js';
import type { Store } from './store.js';
import type { Tasks } from './tasks.js';
import type { Folders } from './folders.js';
import type { Workplaces } from './workplaces.js';
/** The sources loaded right now. A source's plugin may come and go while this one runs. */
export declare class Sources {
    private readonly changed;
    private readonly loaded;
    constructor(changed?: () => void);
    register(source: Source): () => void;
    get(id: string): Source | undefined;
    list(): Source[];
}
export interface ServiceHost {
    store: Store;
    tasks: Tasks;
    sources: Sources;
    /** The built-in source for bugs a person types in. */
    manual?: ManualSource;
    workplaces: Pick<Workplaces, 'projects' | 'inspect' | 'machine'>;
    /** The machines on which other DSHes can hand bugs to this one, when that is switched on. */
    relay?(): {
        label: string;
        routes: string[];
        error?: string;
    }[];
    folders: Pick<Folders, 'add' | 'repository'>;
    now?(): number;
}
export interface SourceView {
    id: string;
    name: string;
    unready?: Message;
    fetches: boolean;
    at?: number;
    error?: string;
    busy: boolean;
}
export interface PoolView extends PoolItem {
    sourceName: string;
}
export interface State {
    settings: Settings;
    /** Loaded sources; a bug whose source is not among them can still be read, not started or written back. */
    sources: SourceView[];
    pool: PoolView[];
    tasks: (Task & {
        running: boolean;
        sourceName: string;
    })[];
    relay: {
        label: string;
        routes: string[];
        error?: string;
    }[];
}
export declare class AutofixService implements Autofix {
    private readonly host;
    readonly version: 1;
    private readonly fetching;
    constructor(host: ServiceHost);
    private now;
    register(source: Source): () => void;
    state(): State;
    /** One task as the board shows it, for a card that follows only that one. */
    task(key: unknown): State['tasks'][number] | undefined;
    saveSettings(raw: unknown): Promise<void>;
    projects(signal?: AbortSignal): Promise<import("./workplaces.js").Project[]>;
    /** A folder on the computer DSH runs on, as a project to choose. Its repository may already be one under another folder. */
    addFolder(path: unknown, signal?: AbortSignal): Promise<{
        project: string;
        projects: import("./workplaces.js").Project[];
        remotes: string[];
    }>;
    /** A project's branches and package folders, for assigning a bug. */
    project(path: string, globs: readonly string[], signal?: AbortSignal): Promise<{
        name: string;
        defaultBase: string | null;
        branches: string[];
        packages: string[];
    }>;
    /** Bugs into the pool. New ones like earlier ones (same title prefix, or same project of the source) get the same place straight away. */
    private merge;
    submit(sourceId: string, items: readonly Item[]): Promise<{
        added: number;
    }>;
    /** Asks one source, or every source that can be asked and is set up. One failing does not stop the others. */
    fetch(sourceId?: string): Promise<{
        added: number;
    }>;
    /** A bug a person typed, with its pictures, into the pool; `assignment` says where it goes, as assigning it would. */
    createManual(input: ManualInput & {
        assignment?: {
            routeId?: unknown;
            branch?: unknown;
            package?: unknown;
        } | null;
    }): Promise<{
        key: string;
    }>;
    /** Throws a bug away for good. Only what no source will hand in again: otherwise the next fetch brings it back. */
    discard(key: unknown): Promise<void>;
    private entry;
    assign(key: unknown, input: {
        routeId?: unknown;
        branch?: unknown;
        package?: unknown;
    } | null): Promise<void>;
    dismiss(key: unknown, dismissed: boolean): Promise<void>;
    /** What the fix changed since it left the base branch, for reading before accepting. */
    diff(key: unknown, signal?: AbortSignal): Promise<{
        stat: string;
        patch: string;
        truncated: boolean;
    }>;
}
export { itemKey, messageOf };
