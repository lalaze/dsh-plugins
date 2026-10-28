export interface WindowProcess {
    close(): Promise<void>;
}
export type LaunchWindow = (url: string, exited: () => void) => Promise<WindowProcess>;
export declare function browserCandidates(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string[];
export declare const launchWindow: LaunchWindow;
