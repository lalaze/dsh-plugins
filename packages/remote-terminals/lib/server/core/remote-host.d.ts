/** The plugin's private directory on every SSH host: installed scripts, relays and shared state live under it. */
export declare const REMOTE_HOME = "\"$HOME/.dsh-remote-agents\"";
/**
 * Shell that prints `<hostname>\0<user>\0<machine id>\0`. Empty machine-id files are readable, so an empty one falls
 * back on the OS name as a read failure does.
 */
export declare const MACHINE_IDENTITY = "dsh_machine_id=\"$(cat /etc/machine-id 2>/dev/null)\"; if [ -z \"$dsh_machine_id\" ]; then dsh_machine_id=\"$(uname -s)\"; fi; printf '%s\\0%s\\0%s\\0' \"$(uname -n)\" \"$(id -un)\" \"$dsh_machine_id\"";
/** The pinned identity of an SSH machine and account, from the fields `MACHINE_IDENTITY` prints. */
export declare const serverIdOf: (machine: string, user: string, unique: string) => string;
/**
 * Shell that installs a Node.js script once per version as `REMOTE_HOME/<name>/<name>-<version>.mjs`, creating
 * `directories` private beside it, then runs `after` and prints `ready`. Without Node.js 18 or newer on the login PATH
 * it prints `missing-node` or `old-node` and installs nothing.
 */
export declare function remoteScript(name: string, version: string, script: string, options?: {
    directories?: string[];
    after?: string;
}): {
    path: string;
    install: string;
};
