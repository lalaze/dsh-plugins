/** The latest thing a step is doing, read from what its model streams. Any provider works: this only looks at the chat's own chunks. */
interface Block {
    type?: string;
    text?: string;
}
export type Chunk = {
    type: 'text-delta' | 'reasoning-delta';
    index: number;
    text: string;
} | {
    type: 'tool-call-delta';
    index: number;
    name?: string;
} | {
    type: 'block-end';
    index: number;
    block: Block;
} | {
    type: string;
};
export declare function lastLine(text: string, limit?: number): string;
export declare class Activity {
    private blocks;
    private last;
    /** A new attempt numbers its blocks from zero again, and what the previous one said still holds until it says something. */
    restart(): void;
    push(chunk: Chunk): void;
    current(): string;
}
export {};
