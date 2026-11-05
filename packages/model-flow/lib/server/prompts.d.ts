/** What each model is told. The goal's own language is kept in every reply. */
export declare const VERDICT_MARK = "FLOW_VERDICT";
export declare const planPrompt: (goal: string) => string;
export declare const implementPrompt: (input: {
    goal: string;
    plan?: string;
    round: number;
    findings?: string;
    lastSummary?: string;
}) => string;
export declare const reviewPrompt: (input: {
    goal: string;
    plan?: string;
    round: number;
    summary?: string;
    findings?: string;
}) => string;
export declare const retryVerdictNote = "\n\nYour reply must end with a line that is exactly \"FLOW_VERDICT: pass\" or \"FLOW_VERDICT: needs_revision\". A previous review of this work left that line out.";
export type Verdict = 'pass' | 'needs_revision';
/** The last verdict line decides, in case the reply quotes the format earlier on. Markdown around it is ignored. */
export declare function parseVerdict(text: string): {
    verdict?: Verdict;
    body: string;
};
