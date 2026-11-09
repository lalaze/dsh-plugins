import type { GoalIdentity } from './claude-goal.js';
interface Send extends GoalIdentity {
    uuid: string;
    nativeSessionId: string;
}
export interface ClaudeGoalOrigin extends Send {
    sourceProofVersion: 1;
    callId: string;
    responseId: string;
    name: string;
    arguments: unknown;
}
export declare const legacyClaudeVersion: (version: unknown) => boolean;
/** Host-only append-only provenance ledger, separate from replaceable/truncatable display history.
 * Neither loading a ledger nor sending a prompt establishes a native reply's authority. Only a
 * matching native user_message_uuid establishes the root turn; response/call IDs never rebind.
 * Frames within that ordered root stream inherit its attested turn until result/next host send.
 */
export declare class ClaudeGoalOrigins {
    private readonly file;
    private sends;
    private closed;
    private responses;
    private calls;
    private pending?;
    private nativeTurn?;
    private modern;
    private legacy;
    private ready;
    private beforeOpen;
    private failed;
    private writes;
    private readonly sharedCalls;
    private readonly sharedResponses;
    constructor(file: string);
    open(priorCalls?: {
        nativeSessionId: string;
        callId: string;
    }[]): Promise<void>;
    private apply;
    private record;
    flush(): Promise<boolean>;
    send(identity: Send): Promise<void>;
    /** Local Stop/close does not leave a stamp usable by a later send. */
    close(): void;
    /** A legacy declaration disables goal proofs, never grants them. Unknown versions remain strict. */
    noteInit(frame: any, nativeSessionId: string): void;
    private live;
    observe(frame: any, nativeSessionId: string, activeMessage?: string): ClaudeGoalOrigin[];
    /** A stale A result never completes B. Explicitly identified legacy producers may finish ordinary output, but
     * they never produce goal-call proofs. Unknown unstamped results are not attributed. */
    resultMatches(frame: any, nativeSessionId: string, activeMessage?: string): boolean;
}
export {};
