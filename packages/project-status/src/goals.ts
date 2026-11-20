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

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/;
const widthOf = (space: string) => [...space].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0);

/** A plain bullet counts as a goal that is not done yet. */
export function parseGoals(text: string): GoalItem[] {
  const items: GoalItem[] = [], indents: number[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const item = ITEM.exec(line);
    if (item) {
      const indent = widthOf(item[1]);
      while (indents.length && indents[indents.length - 1] >= indent) indents.pop();
      items.push({ depth: indents.length, done: (item[2] ?? ' ') !== ' ', text: item[3].trim() });
      indents.push(indent);
      continue;
    }
    const indent = widthOf(/^\s*/.exec(line)![0]);
    // An indented line belongs to the item above it; one at the margin ends the list.
    if (!indent) indents.length = 0;
    items.push({ depth: indents.filter(open => open < indent).length, text: line.trim() });
  }
  return items;
}

export function serializeGoals(items: GoalItem[]): string {
  return items.map(item => `${'  '.repeat(item.depth)}${item.done === undefined ? '' : `- [${item.done ? 'x' : ' '}] `}${item.text}`).join('\n');
}

/** The index after the last item that belongs under `items[index]`. */
export function endOf(items: GoalItem[], index: number): number {
  let end = index + 1;
  while (end < items.length && items[end].depth > items[index].depth) end++;
  return end;
}

/** How many of the boxes are ticked: among the steps of one goal, or in the whole list. */
export function tally(items: GoalItem[], index?: number): { done: number; total: number } {
  const steps = (index === undefined ? items : items.slice(index + 1, endOf(items, index))).filter(item => item.done !== undefined);
  return { done: steps.filter(item => item.done).length, total: steps.length };
}
