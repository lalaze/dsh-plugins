/**
 * The Goal section read as a list to tick off: goals, and under each the steps it breaks down into. In the file it is a
 * Markdown task list, which agents write and tick as readily as the tab does:
 *
 *     - [ ] Ship the payment page
 *       - [x] Design
 *       - [ ] Build
 *
 * People and agents also write plain sentences there, so a line that is no list item is kept as a note, without a box.
 * Shared by the tab, which draws the list, and the tests.
 */
export interface GoalItem {
    /** 0 for a goal, 1 for a step of the goal above it; deeper levels are kept as they were written. */
    depth: number;
    /** Absent for a note: a line that is not a list item. */
    done?: boolean;
    text: string;
}
/** A plain bullet counts as a goal that is not done yet. */
export declare function parseGoals(text: string): GoalItem[];
export declare function serializeGoals(items: GoalItem[]): string;
/** The index after the last item that belongs under `items[index]`. */
export declare function endOf(items: GoalItem[], index: number): number;
/** How many of the boxes are ticked: among the steps of one goal, or in the whole list. */
export declare function tally(items: GoalItem[], index?: number): {
    done: number;
    total: number;
};
