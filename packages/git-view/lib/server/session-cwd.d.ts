type Lookup = (name: string) => unknown;
/** The directory a conversation started in, from the live session or, before it is opened, from saved sessions. */
export declare function sessionCwd(get: Lookup, sessionId: string): Promise<string | undefined>;
/**
 * The directory a conversation works in now. A session that moved, into a worktree or with a `cd`, keeps the project in
 * its header and records the move in DSH's `workingDirectory` projection. A remote workspace stays on its anchor, because
 * Remote Agents finds the machine and folder for Git from the anchor.
 */
export declare function workingDirectoryOf(get: Lookup, sessionId: string, isRemote?: (cwd: string) => boolean): Promise<string | undefined>;
export {};
