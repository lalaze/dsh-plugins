/** The engine an npm manifest depends on, or `Cocos Creator` for a manifest that engine wrote. */
export declare function engineOfPackage(manifest: string): string | undefined;
/**
 * The game engine a folder is a project of, or undefined. Looks at the folder itself and, for npm manifests, at the
 * folders directly inside it, where a repository often keeps its game beside a server or tools.
 */
export declare function detectEngine(root: string): Promise<string | undefined>;
