/**
 * dsh-remote-agents 0.2.53 and earlier stored a remote CLI row's tool/call when its first tool started, but the
 * assistant/message advertising it only when the response ended (or never, when DSH quit mid-response). DSH refuses
 * to reopen such a log: "tool/call remote-1-1-cli has no advertised tool lifecycle". Each such log is repaired once:
 * the advertising message moves ahead of its call (or is added when missing) and every event reference follows.
 * An interrupted response stays an open turn, which DSH closes itself when the conversation reopens.
 */
export interface Row {
    type: string;
    seq: number;
    time: number;
    data?: any;
    surfaceOp?: unknown;
    sourceEventSeqs?: number[];
    [key: string]: unknown;
}
/**
 * Put each remote CLI row's advertising message directly before its tool/call and renumber the log.
 * @returns the repaired rows, or undefined when the log needs no repair.
 */
export declare function repairRows(rows: Row[]): Row[] | undefined;
/** Split a concatenated Zstandard log into complete frames and a torn final frame; undefined for a foreign file. */
export declare function zstdFrames(buffer: Buffer): {
    frames: Buffer[];
    torn?: Buffer;
} | undefined;
/**
 * Repair one stored DSH log in place, keeping the original under `backupDir`.
 * @param skip - session ids DSH has open; their logs are left alone.
 * @returns 'repaired', 'skipped' for an open session, or undefined when the log needs no repair.
 */
export declare function repairSessionLog(path: string, backupDir: string, skip?: (id: string) => boolean): Promise<'repaired' | 'skipped' | undefined>;
/**
 * Repair every stored DSH log written in the old order. Runs until one pass leaves nothing skipped, then never again.
 * @param root - DSH's session root (`<project>/<session>/session.v4.jsonl.zstd`).
 * @param stateDir - this plugin's state directory: holds the completion marker and the original logs.
 * @param skip - session ids DSH has open.
 * @returns the repaired log paths.
 */
export declare function repairStoredSessions(root: string, stateDir: string, skip?: (id: string) => boolean): Promise<string[]>;
