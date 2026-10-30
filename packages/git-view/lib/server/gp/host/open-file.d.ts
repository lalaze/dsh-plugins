import type { SnapshotDeps } from './core.js';
import type { GitOpenFileResult } from './types.js';
/** Platform argv that opens one file with its default handler. */
export declare function openerArgv(platform: string, target: string): readonly string[] | null;
/** Whether this host can hand a file to the desktop at all. */
export declare function canOpenWithSystem(platform: string): boolean;
/**
 * Resolve `path` inside `root` and open it with the OS default application.
 *
 * @param deps Host fs face (realpath containment).
 * @param root Browse root for the session.
 * @param path Browse-root-relative path from the client (untrusted).
 * @param spawn Runs one argv and resolves with its exit code, or null on failure.
 * @returns The absolute path on success, a typed failure otherwise.
 */
export declare function openWithSystem(deps: SnapshotDeps, root: string, path: string, spawn: (argv: readonly string[]) => Promise<number | null>, platform?: string): Promise<GitOpenFileResult>;
