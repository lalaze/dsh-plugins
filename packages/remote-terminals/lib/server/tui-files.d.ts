/**
 * A file's name on the remote machine: recognizable, with nothing a shell or Claude Code's path detection must be careful
 * about. That includes the narrow space in a macOS screenshot's name, which spaces alone would miss.
 * @param value - the name the browser gave, which nothing vouches for.
 */
export declare function tuiFileName(value: unknown): string;
/** Where a file goes, relative to the project. The same file given twice has one copy, and two files never collide. */
export declare const tuiFilePath: (sha256: string, name: string) => string;
/**
 * Files given to a TUI conversation's Claude Code, which runs on another machine and can see none of this one's. They go
 * inside the project because Claude Code asks before reading outside it, and stay there, as a chat's attachments do.
 */
export declare class TuiFiles {
    private readonly dsh;
    constructor(dsh: {
        isTui(sessionId: string): boolean;
        /** A private directory on this machine. */
        directory: string;
        /** Saves a file on the conversation's machine and returns its absolute path. */
        attach(sessionId: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal: AbortSignal): Promise<string>;
    });
    /**
     * The file is staged here first: that gives the digest the SSH upload checks, and a transfer the browser gives up on
     * never reaches the machine.
     * @returns the file's absolute path on the conversation's machine.
     */
    upload(sessionId: string, name: unknown, input: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string>;
}
