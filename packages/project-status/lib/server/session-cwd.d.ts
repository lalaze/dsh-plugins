type Lookup = (name: string) => unknown;
/**
 * The directory a conversation works in now: a session that moved into a worktree shows that worktree's assets. A remote
 * workspace stays on its anchor, which the service refuses.
 */
export declare function workingDirectoryOf(get: Lookup, sessionId: string): Promise<string | undefined>;
export {};
