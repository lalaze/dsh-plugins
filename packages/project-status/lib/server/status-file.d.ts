import { type Goal } from './domain.js';
/** A goal as the file has it: with whatever else was written under it. */
export interface ParsedGoal extends Goal {
    /** Fourth-level sections besides the three, heading lines included, as written. */
    rest: string[];
}
export interface ParsedStatus {
    /** What stands before the first section: usually a title line. */
    preamble: string;
    aim: string;
    goals: ParsedGoal[];
    /** The headings the two sections had in the file. */
    headings: {
        aim?: string;
        goals?: string;
    };
    /** What stands in the goals' section before the first goal. */
    lead: string;
    /** Every other section, heading line included, as written. */
    extra: string[];
    /** The language the file's own headings are in, when it has any. */
    language?: 'zh' | 'en';
}
/** A text as the file holds it: without the blank lines around it. */
export declare const tidy: (text: string) => string;
/** A goal's name: one line, without the box an agent may have copied along. */
export declare const tidyTitle: (text: string) => string;
export declare function parseStatus(text: string): ParsedStatus;
/**
 * @param language - of the headings, for a file that has none yet.
 * @param title - the title of a file that had nothing before its first section.
 */
export declare function serializeStatus(status: ParsedStatus, language: 'zh' | 'en', title: string): string;
/** What the tab and other plugins are told of a goal. */
export declare const shown: ({ rest: _rest, ...goal }: ParsedGoal) => Goal;
