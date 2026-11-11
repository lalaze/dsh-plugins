/**
 * Host half: stores workspace tags in the DSH home, so every client of this
 * host (desktop or remote web) sees the same tags. The sidebar itself is the
 * client half, a fork of DSH's ui-workspace that this package's bundle patch
 * swaps in for the stock one.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { TagStore } from './server/store.js';
import { type TagState } from './shared/tags.js';
/**
 * What other host plugins may do with the tags, as the service `workspaceTags`.
 */
export interface WorkspaceTagsService {
    readonly version: 1;
    snapshot(): TagState;
    /** Save a merged state; invalid entries are dropped and the user's tag order stays on. Open sidebars pick it up on their next refresh. */
    replace(state: TagState): Promise<TagState>;
    /** Called after each saved change, including those made through {@link replace}. */
    subscribe(listener: (state: TagState) => void): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        workspaceTags: WorkspaceTagsService;
    }
}
export declare const name = "dsh-workspace-tags";
export declare const inject: string[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: {
    stateDir?: string;
}): Promise<void>;
export declare function handleTagRequest(store: TagStore, request: Request, headers?: Record<string, string>): Promise<Response>;
