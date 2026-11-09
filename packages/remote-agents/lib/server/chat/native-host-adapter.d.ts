/** Audited public 0.2.2-rc.1 compose/prompt seams, loaded from the HOST's
 * runtime rather than the plugin's older optional SDK facade. */
export declare function nativeHostAdapter(ctx: any): {
    load: (name: string) => Promise<any>;
    /** Source-audited 0.2.2-rc.1 title boundary, including preparation and the
     * post-stream title append. runProvider is a host implementation seam,
     * NOT an optional SDK hook; incompatible hosts must fail closed. */
    fenceLifecycle(hooks: {
        enter(id: string): void;
        leave(id: string): void;
        admit(id: string): Promise<void>;
        rejected(id: string, line: string, attachments: unknown[]): void;
    }): void;
    setup(agentCtx: any): Promise<void>;
    /** Native compaction selects its span BEFORE streaming. Rebuild only its
     * public summarizer input, without changing that span during the call. The
     * native summarizer logs the resulting exact request in compaction/summary. */
    compactionInput(input: any, agent: any, signal?: AbortSignal): Promise<any>;
};
