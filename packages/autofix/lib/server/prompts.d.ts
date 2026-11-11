/** What the models are told. English, as instructions for models; the bug itself stays in its own words. */
import type { Item, Route } from './domain.js';
export interface GoalInput {
    item: Item;
    /** The tracker the bug is in; absent for a bug a person typed in. */
    sourceName?: string;
    route: Pick<Route, 'name' | 'packageGlobs' | 'sharedPaths' | 'tests'>;
    baseBranch: string;
    packageHint?: string;
    /** What the person said when sending the fix back. */
    feedback?: string;
    /** The checks that failed after the previous round, with their output. */
    failedCheck?: string;
    /** Whether earlier rounds already changed (and maybe committed) files here. */
    continued: boolean;
    /** How many pictures the person added to what they said; they are attached after the bug's own. */
    feedbackPictures?: number;
    /** Which of the bug's pictures come attached, by their place in the bug from 0, in the order they are attached. */
    attached?: readonly number[];
}
export declare function taskGoal(input: GoalInput): string;
export declare const commitMessage: (item: Pick<Item, "source" | "ref" | "title">) => string;
export declare const mergeMessage: (item: Pick<Item, "source" | "id" | "title">) => string;
export declare const conversationTitle: (item: Pick<Item, "ref" | "title">) => string;
/** A branch for the bug: the source, then what names the bug there, kept to what Git allows in a ref. */
export declare const branchName: (item: Pick<Item, "source" | "id">) => string;
