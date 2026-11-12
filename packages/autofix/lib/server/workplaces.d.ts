export interface GitStep {
    argv: string[];
    timeoutMs?: number;
}
export interface GitResult {
    code: number | null;
    stdout: string;
    stderr: string;
}
export type Location = {
    kind: 'local';
} | {
    kind: 'remote';
    hostId: string;
    host: string;
};
/** A workspace's folder on its machine. */
export interface Machine {
    location: Location;
    folder: string;
    git(steps: GitStep[], options?: {
        reads?: boolean;
        signal?: AbortSignal;
    }): Promise<GitResult[]>;
    shell(command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
    read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
}
export interface Project {
    path: string;
    title: string;
    location: Location;
    folder: string;
}
/** `repository` is the repository's main folder on its machine: the same for every workspace and worktree of it. */
export interface ProjectDetail {
    name: string;
    defaultBase: string | null;
    branches: {
        name: string;
        local: boolean;
        remote?: string;
    }[];
    setup: string[];
    repository?: string;
    location?: Location;
}
export interface Created {
    path: string;
    worktree: string;
    branch: string;
    warnings: string[];
}
export declare class Workplaces {
    private readonly service;
    private readonly pollMs;
    constructor(service: (name: string) => unknown, pollMs?: number);
    private worktrees;
    projects(signal?: AbortSignal): Promise<Project[]>;
    inspect(project: string, signal?: AbortSignal): Promise<ProjectDetail>;
    machine(path: string, signal?: AbortSignal): Promise<Machine>;
    /**
     * A worktree on a new branch from `base`, added to DSH as a workspace. The repository's own setup commands run without
     * asking: nobody is there, and the models that follow run commands from the same repository anyway.
     */
    create(input: {
        project: string;
        base: string;
        branch: string;
    }, signal: AbortSignal): Promise<Created>;
    /**
     * Takes a worktree away: its conversations are archived, its folder is deleted and its workspace leaves DSH. The branch
     * stays. Refused while the worktree holds anything that exists nowhere else, as nobody is shown what would be lost.
     * `project` is a workspace of the same repository. Returns what there is to know afterwards.
     */
    remove(input: {
        project: string;
        worktree: string;
    }, signal: AbortSignal): Promise<string[]>;
}
