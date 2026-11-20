const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/;
const widthOf = (space) => [...space].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0);
/** A plain bullet counts as a goal that is not done yet. */
export function parseGoals(text) {
    const items = [], indents = [];
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        if (!line.trim())
            continue;
        const item = ITEM.exec(line);
        if (item) {
            const indent = widthOf(item[1]);
            while (indents.length && indents[indents.length - 1] >= indent)
                indents.pop();
            items.push({ depth: indents.length, done: (item[2] ?? ' ') !== ' ', text: item[3].trim() });
            indents.push(indent);
            continue;
        }
        const indent = widthOf(/^\s*/.exec(line)[0]);
        // An indented line belongs to the item above it; one at the margin ends the list.
        if (!indent)
            indents.length = 0;
        items.push({ depth: indents.filter(open => open < indent).length, text: line.trim() });
    }
    return items;
}
export function serializeGoals(items) {
    return items.map(item => `${'  '.repeat(item.depth)}${item.done === undefined ? '' : `- [${item.done ? 'x' : ' '}] `}${item.text}`).join('\n');
}
/** The index after the last item that belongs under `items[index]`. */
export function endOf(items, index) {
    let end = index + 1;
    while (end < items.length && items[end].depth > items[index].depth)
        end++;
    return end;
}
/** How many of the boxes are ticked: among the steps of one goal, or in the whole list. */
export function tally(items, index) {
    const steps = (index === undefined ? items : items.slice(index + 1, endOf(items, index))).filter(item => item.done !== undefined);
    return { done: steps.filter(item => item.done).length, total: steps.length };
}
