/**
 * Which images a project's code refers to, found by reading the code as text. Nothing is executed, so a path the game
 * builds at run time is reported as a weaker `pattern`, `folder` or `name` reference rather than as a use.
 */
import { type Reference, type ReferenceKind, type Usage } from './domain.js';
/** Files that are code wherever they are: every reference in them counts. */
export declare const SOURCE_EXTENSIONS: Set<string>;
/**
 * Manifests, atlases and maps. One of these counts only when code, or another counted file, names it: metadata a
 * generator left beside its images would otherwise mark every image it lists as used.
 */
export declare const DATA_EXTENSIONS: Set<string>;
export interface Location {
    file: string;
    line: number;
    text: string;
}
export interface Mention {
    token: string;
    pattern: boolean;
    extension: string;
    line: number;
    column: number;
}
export interface Extracted {
    mentions: Mention[];
    folders: {
        dir: string;
        line: number;
        column: number;
    }[];
    lines: string[];
}
/**
 * A path as written in code, comparable with a workspace path: `/` separators, no leading `./`, `../`, `/`, `~/` or
 * `@/`, and each interpolation (`${id}`, `{id}`, `%s`, `%d`) as `*`. Undefined when nothing nameable is left.
 */
export declare function normalizeToken(raw: string): {
    token: string;
    pattern: boolean;
} | undefined;
/** Every image or data path written in `text`, and every quoted folder such as `'art/cats/'`. */
export declare function extract(text: string): Extracted;
/** The line around `column`, short enough to show: a minified line is cut to the part that holds the reference. */
export declare function snippet(line: string, column: number): string;
/** Paths found by their ending: `cats/a.png` finds `public/art/cats/a.png`. Image paths compare without the extension. */
export declare class SuffixIndex {
    private readonly ignoreExtension;
    private readonly byName;
    private readonly entries;
    constructor(paths: readonly string[], ignoreExtension: boolean);
    /** Entries named like the token's last part, the ones the token's extension matches, and the token's depth. */
    private candidates;
    /**
     * What a literal path refers to. A path of two or more parts, or a bare name only one entry has, is certain; a bare
     * name several entries share is certain for the single one with the same extension and a `name` reference for the rest.
     */
    literal(token: string, extension: string): {
        index: number;
        kind: ReferenceKind;
    }[];
    /** Entries a path with `*` interpolations could name; empty when the pattern has too little literal text to mean anything. */
    pattern(token: string): number[];
    /** Entries with this bare name, for words that are a name without its extension. */
    named(name: string): number[];
    names(): IterableIterator<string>;
}
export interface ReferenceInput {
    /** Image paths, relative to the workspace. */
    assets: readonly string[];
    /** Code files: all are read. */
    sources: readonly string[];
    /** Data files: read once a file already read names them. */
    data: readonly string[];
    /** A file's text, or undefined when it is unreadable, binary or too large. */
    read(path: string): Promise<string | undefined>;
}
export interface ReferenceOutput {
    refs: Reference[][];
    counts: number[];
    usage: Usage[];
    filesRead: number;
}
/** References to each image, strongest first, with a verdict: used, maybe (only computed or ambiguous references), unused. */
export declare function findReferences(input: ReferenceInput): Promise<ReferenceOutput>;
