const LINK = /!?\[((?:\\.|[^\]\\])*)\]\([^)]*\)/gu;
/** One line of Markdown as plain text. Code fences and rules come out empty, so the line before them is used. */
const plain = (line) => line
    .replace(LINK, '$1')
    .replace(/\\([\\`*_~[\]<>|$&])/gu, '$1')
    .replace(/^\s*(?:#+\s+|>+\s*|[-*+]\s+|\d+\.\s+)/u, '')
    .replace(/`+|\*\*/gu, '')
    .replace(/^[-=_~\s]+$/u, '')
    .trim();
export function lastLine(text, limit = 200) {
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = plain(lines[index]);
        if (line)
            return [...line].length <= limit ? line : `${[...line].slice(0, limit).join('')}…`;
    }
    return '';
}
export class Activity {
    blocks = new Map();
    last = '';
    /** A new attempt numbers its blocks from zero again, and what the previous one said still holds until it says something. */
    restart() { this.last = this.current(); this.blocks.clear(); }
    push(chunk) {
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && 'text' in chunk)
            this.blocks.set(chunk.index, (this.blocks.get(chunk.index) ?? '') + chunk.text);
        else if (chunk.type === 'tool-call-delta' && 'index' in chunk && 'name' in chunk && chunk.name)
            this.blocks.set(chunk.index, chunk.name);
        // Closing a block again takes back text shown after it, which is how a remote CLI's "running this tool" line goes away.
        else if (chunk.type === 'block-end' && 'block' in chunk && typeof chunk.block.text === 'string')
            this.blocks.set(chunk.index, chunk.block.text);
    }
    current() {
        for (const index of [...this.blocks.keys()].sort((a, b) => b - a)) {
            const line = lastLine(this.blocks.get(index));
            if (line)
                return line;
        }
        return this.last;
    }
}
