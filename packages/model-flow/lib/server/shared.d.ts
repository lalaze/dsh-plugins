/** Used on both sides, so it must not import anything from Node. */
export declare const API_PATH = "/api/model-flow";
export interface EffortOption {
    id: string;
    label: string;
}
export type Locale = 'en' | 'zh';
/** What the client asks about a running row. Text is ready to show, in the language of the goal. */
export interface LiveStep {
    title: string;
    elapsed: string;
    activity: string;
    parentId: string;
    childId?: string;
}
/** Rows are saved as text: a title, then the full result, then what the row needs to know that is not for reading. */
export interface RowParts {
    title: string;
    body?: string;
    parentId?: string;
    childId?: string;
    open?: boolean;
}
export declare function rowText({ title, body, parentId, childId, open }: RowParts): string;
export declare function parseRow(text: string): RowParts;
