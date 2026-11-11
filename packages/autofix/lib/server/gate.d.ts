/** What must hold before a fix is committed: nothing sensitive in it, and which packages it touched. */
import { type Message, type Route } from './domain.js';
/** `git status --porcelain=v1 -z` as paths; a rename counts as its new path. */
export declare function changedFiles(porcelain: string): string[];
/** Why this fix may not be committed at all, or undefined. */
export declare function blocked(files: readonly string[], addedLines: string): Message | undefined;
/** The lines a diff adds, without its headers. */
export declare const addedLines: (diff: string) => string;
export interface Touched {
    packages: string[];
    shared: string[];
    other: string[];
}
/** A fix's files sorted by where they are: business packages, the shared paths, and everything else. */
export declare function touched(files: readonly string[], route: Pick<Route, 'packageGlobs' | 'sharedPaths'>): Touched;
/** What a person should look at before accepting. None of it stops a task. */
export declare function warnings(found: Touched, route: Pick<Route, 'packageGlobs'>, hint?: string): Message[];
/** The first script of `priority` a package.json has. */
export declare function chooseScript(packageJson: string | undefined, priority: readonly string[]): string | undefined;
/**
 * The commands to run: a template naming `{package}` or `{script}` once per package, the rest once. A package without
 * any of the build scripts skips the templates that need `{script}`, and says so.
 */
export declare function commands(templates: readonly string[], packages: readonly {
    path: string;
    script?: string;
}[]): {
    run: string[];
    skipped: Message[];
};
