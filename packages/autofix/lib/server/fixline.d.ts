/** What a person types after /fix: optionally where the bug goes, then the bug in their own words. */
export interface FixLine {
    repo?: string;
    branch?: string;
    title: string;
    body: string;
}
/** `repo=` and `branch=` may lead the line, in either order; a name with spaces goes in quotes. The first line becomes the title. */
export declare function parseFix(raw: string): FixLine;
