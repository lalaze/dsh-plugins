/** The bugs waiting to be handed out: what the last fetch found, and where each one should go. */
import { type Assignment, type Item, type PoolItem } from './domain.js';
export type Pool = Record<string, PoolItem>;
/** What a team writes in front of a bug's title to say where it belongs, as `【活动页】` or `H5:`. */
export declare function titlePrefix(title: string): string | undefined;
/**
 * A source's open bugs merged in: new ones added, known ones refreshed. With `complete`, the source's bugs that are
 * missing are marked stale; a source that only hands some in says nothing about the rest. What a person chose stays.
 */
export declare function refresh(pool: Pool, source: string, items: readonly Item[], now: number, complete?: boolean): {
    pool: Pool;
    added: number;
};
/** What is remembered about where bugs go, by `prefix:<source>:<title prefix>` and `project:<source>:<project id>`. */
export type Memory = Readonly<Record<string, Assignment>>;
export declare const prefixKey: (item: Pick<Item, "source" | "title">) => string | undefined;
export declare const projectKey: (item: Pick<Item, "source" | "project">) => string | undefined;
/**
 * Where a bug like this went before. Bugs of the same source with the same title prefix decide, when they all agree
 * (two answers for one prefix is no answer); then what accepted fixes taught: the prefix, then the source's project,
 * which names a repository and a branch but no package.
 */
export declare function suggest(pool: Pool, item: Pick<Item, 'source' | 'title' | 'project'>, memory?: Memory): Assignment | undefined;
/** Lists for a page: waiting first, newest first; dismissed and stale ones last. */
export declare function ordered(pool: Pool): PoolItem[];
