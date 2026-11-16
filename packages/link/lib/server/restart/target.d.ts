import type { AgentLike, JobLike } from '../dsh.js';
export type Launch = 
/** A launchd job (the hub's LaunchAgent): `launchctl kickstart -k` stops it and starts it again. */
{
    kind: 'launchd';
    target: string;
}
/** The desktop app: its main process is asked to quit, then the bundle is opened again. */
 | {
    kind: 'desktop';
    quitPid: number;
    hostPid: number;
    bundle: string;
}
/** `dsh web` from a shell: the same command line again, in the same directory, with the same environment. */
 | {
    kind: 'process';
    pid: number;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
};
export type Target = {
    ok: true;
    launch: Launch;
} | {
    ok: false;
    reason: string;
};
export interface ProcessFacts {
    platform: NodeJS.Platform;
    pid: number;
    ppid: number;
    uid: number;
    execPath: string;
    execArgv: string[];
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    ipc: boolean;
    /** `ps -o command=` of a process. */
    commandOf(pid: number): string | undefined;
    /** `launchctl print <target>`, undefined when there is no such job. */
    launchctlPrint(target: string): string | undefined;
}
export declare function processFacts(): ProcessFacts;
export declare function launchEnv(env: NodeJS.ProcessEnv): Record<string, string>;
export declare function restartTarget(facts: ProcessFacts): Target;
export interface Busy {
    sessions: {
        id: string;
        title?: string;
    }[];
    jobs: {
        id: string;
        label: string;
    }[];
}
/** What a quit would interrupt, as the desktop app's own quit check sees it: running or queued turns, running jobs. */
export declare function inspectBusy(agents: {
    list(): readonly AgentLike[];
} | undefined, jobs: {
    list(owner?: string): readonly JobLike[];
} | undefined, titleOf: (agent: AgentLike) => string | undefined): Busy;
export interface Versions {
    dsh?: string;
    plugins: Record<string, string>;
}
export interface VersionChange {
    name: string;
    from?: string;
    to?: string;
}
/** DSH's version (the package above its entry script) and the profile's plugins, best effort. */
export declare function readVersions(profileDir: string | undefined, entry: string | undefined): Versions;
export declare function versionChanges(from: Versions, to: Versions): VersionChange[];
