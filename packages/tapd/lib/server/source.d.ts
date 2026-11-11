/** TAPD as a source of bugs for dsh-autofix: its open bugs in, and what happened to them written back. */
import type { Bug, TapdSettings } from './settings.js';
import { type TapdClient } from './tapd.js';
/** dsh-autofix's side of the bargain; see its `Source`, `Item` and `ItemEvent`. */
export interface Item {
    source: string;
    id: string;
    ref: string;
    title: string;
    body: string;
    url?: string;
    project?: {
        id: string;
        name: string;
    };
    status?: string;
    priority?: string;
    module?: string;
    labels: string[];
    images?: number;
}
export type ItemEvent = {
    kind: 'started';
    baseBranch: string;
} | {
    kind: 'review';
    branch: string;
    commit: string;
    checks: number;
} | {
    kind: 'accepted';
    baseBranch: string;
    branch: string;
    commit: string;
    mergeCommit?: string;
};
export interface Message {
    key: string;
    values?: Record<string, string>;
    detail?: string;
}
export interface Source {
    id: string;
    name: string;
    unready?(): Message | undefined;
    fetch?(signal?: AbortSignal): Promise<Item[]>;
    report?(item: Item, event: ItemEvent): Promise<void>;
    image?(item: Item, index: number, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        mediaType: string;
        name?: string;
    } | undefined>;
}
export interface Autofix {
    readonly version: number;
    register(source: Source): () => void;
}
export declare const SOURCE_ID = "tapd";
export declare function itemOf(bug: Bug, settings: Pick<TapdSettings, 'workspaces'>): Item;
/** What TAPD is told. A status or a comment the settings switch off is simply not written. */
export declare function writeBack(event: ItemEvent, settings: Pick<TapdSettings, 'doneStatus' | 'inProgressStatus' | 'commentOnReview'>, zh: boolean): {
    status?: string;
    comment?: string;
} | undefined;
export declare function tapdSource(client: Pick<TapdClient, 'listBugs' | 'update' | 'getBug' | 'image'>, settings: () => TapdSettings): Source;
