/**
 * HTTPS credentials saved from the Git view for local workspaces, in Git's own `store` format, in a file of this plugin
 * that only its own Git commands read. For each saved host they replace the other credential helpers, so a credential
 * from the system keychain is never copied into the file and Git in a terminal is unaffected.
 */
export declare class Credentials {
    private readonly file;
    constructor(file: string);
    private lines;
    private hostOf;
    /** `-c` options before each Git command. */
    config(): Promise<string[]>;
    /** Replaces the host's saved credential. */
    save(host: unknown, username: unknown, password: unknown): Promise<void>;
}
