/** Git's answer in `folder`, without the last line break; undefined when Git refuses or is missing. */
export type RunGit = (folder: string, args: string[]) => Promise<string | undefined>;
export interface AddedFolder {
    folder: string;
    repository: string;
    remotes: string[];
}
export declare class Folders {
    private readonly service;
    private readonly run;
    /** `service` looks a DSH service up by name at the moment it is needed. */
    constructor(service: (name: string) => unknown, run?: RunGit);
    /** The repository's own Git folder, which the repository and every worktree of it share. */
    repository(folder: string): Promise<string | undefined>;
    /** Opens the repository that holds `typed` as a workspace. A folder inside a repository stands for the whole repository. */
    add(typed: string): Promise<AddedFolder>;
}
