import type { GitRunner } from './git.js';
import type { AgentDefaultModelFace, LlmFace, SessionModelSelection } from './llm-face.js';
import type { DiffViewMode, FontDelta, GraphStyle, GitChange, GitErrorCode, GitPanelPlacement, GitRemote, GitRepoList, GitSnapshotResult, SuggestLanguage } from './types.js';
export interface GitPanelConfig {
    readonly timeoutMs: number;
    /** Per-command stdout cap; also the per-side image-diff and image-preview
     * payload cap. Range 64 KiB – 64 MiB. */
    readonly maxBytes: number;
    readonly maxChanges: number;
    readonly refreshIntervalMs: number;
    /** Probe worktrees and nested repositories for the repository list. Off →
     * the list is the cwd's own repository alone (none when the cwd is not one). */
    readonly detectCheckouts: boolean;
    /** The file browser follows repository switches; off → it stays at the
     * project root (the workspace the cwd belongs to). */
    readonly filesFollowRepo: boolean;
    /** Whether the input-bar git marker pill is shown. */
    readonly showInputPill: boolean;
    /** Where the panel is mounted: the view tab, the right sidebar, or both. */
    readonly placement: GitPanelPlacement;
    /** Default diff layout the views open with (user can switch per-diff). */
    readonly defaultDiffView: DiffViewMode;
    /** Commit-graph line style (parallel = VSCode-like, compact = git log). */
    readonly graphStyle: GraphStyle;
    /** Panel font-size step: -1 / 0 / +1. */
    readonly fontDelta: FontDelta;
    /** Whether the "AI suggest" button shows in the commit box. */
    readonly suggestEnabled: boolean;
    /** Language the generated message is written in; `auto` follows repo history. */
    readonly suggestLanguage: SuggestLanguage;
    /** Max diff bytes sent to the model; beyond this the diff is truncated. Range 16–512 KiB. */
    readonly suggestMaxBytes: number;
    /** Model output token budget (reasoning tokens count against it on thinking models). Range 256–16384. */
    readonly suggestMaxOutputTokens: number;
    /** Timeout for one suggest call. Range 5–120 s. */
    readonly suggestTimeoutMs: number;
    /** Optional provider/model route override; absent → the agent default. */
    readonly suggestProvider?: string;
    readonly suggestModel?: string;
    /** Adapter-owned effort for the fixed route; absent → omit from the request
     * (the model / adapter default applies). Ignored when the route is not fixed. */
    readonly suggestReasoningEffort?: string;
}
export declare const DEFAULT_CONFIG: GitPanelConfig;
export declare function normalizeConfig(raw: unknown): GitPanelConfig;
/**
 * Read the panel-mount field, unwrapping a schemastery volatile ref. An
 * unknown string (a hand-edited profile, or a value from a newer version)
 * falls back to the default rather than mounting nowhere.
 */
export declare function readPlacement(value: unknown, fallback: GitPanelPlacement): GitPanelPlacement;
/**
 * Read the default-diff-view field, unwrapping a schemastery volatile ref. */
export declare function readDiffView(value: unknown, fallback: DiffViewMode): DiffViewMode;
/** Read the commit-graph style field, unwrapping a schemastery volatile ref. */
export declare function readGraphStyle(value: unknown, fallback: GraphStyle): GraphStyle;
/** Read the panel font-size step, unwrapping a schemastery volatile ref. */
export declare function readFontDelta(value: unknown): FontDelta;
/**
 * Read the commit-message language field, unwrapping a schemastery volatile
 * ref. An unknown string (a hand-edited profile, or a value from a newer
 * version) falls back to the default rather than reaching the prompt.
 */
export declare function readSuggestLanguage(value: unknown, fallback: SuggestLanguage): SuggestLanguage;
/**
 * Read a boolean config field, unwrapping a schemastery volatile reference
 * (`{ get() }`) so a live-editable toggle reflects the latest value. Absent or
 * unrecognized shapes fall back to the default.
 */
export declare function readBool(value: unknown, fallback: boolean): boolean;
/** Host capabilities the snapshot needs, structurally injected. */
export interface SnapshotDeps {
    readonly run: GitRunner;
    readonly fs: {
        realpath(path: string): Promise<string>;
        /** `isDirectory` reports the *resolved* type (symlinks are followed). */
        stat(path: string): Promise<{
            mtimeMs: number;
            size: number;
            isDirectory(): boolean;
        }>;
        /** Raw bytes (no encoding) — image sides for the image-diff query. */
        readFile(path: string): Promise<Buffer>;
        /**
         * A symlink's target text, else null. git stores the LINK as the worktree
         * blob (mode 120000), so the diff's new side is the target string, not the
         * file it points at — following the link would describe a different file.
         */
        symlinkTarget(path: string): Promise<string | null>;
        /** One directory's entries (name + is-directory) — the file browser. */
        readdir(path: string): Promise<ReadonlyArray<{
            name: string;
            isDirectory: boolean;
        }>>;
        /** Recursive remove (force) — untracked discards pass whole directories; temp-blob cleanup passes files. */
        remove(path: string): Promise<void>;
    };
    readonly sessions: {
        liveCwd(sessionId: string): string | undefined;
        persistedMeta(sessionId: string): Promise<{
            cwd?: string;
        } | undefined>;
    };
    readonly signal?: AbortSignal;
    /**
     * Optional cwd+selector→root cache. Resolving the work-tree root runs a
     * `git rev-parse` + `realpath` on every call; sharing this map across a
     * session's snapshot/query/run calls collapses that to one spawn per distinct
     * (cwd, repository) pair. The key is built by `rootCacheKey`, so the default
     * repository and a nested one under the same cwd never alias.
     */
    readonly rootCache?: Map<string, string>;
    /**
     * Optional negative cache (cwd+selector → expiry epoch ms), so a session whose
     * directory is not a git repo does not spawn `rev-parse` on every 30s poll.
     * Short-lived (see NEG_CACHE_MS) so a repo created under the cwd is picked up
     * soon after.
     */
    readonly rootNegCache?: Map<string, number>;
    /**
     * Optional per-request resolvers for the host model services (see
     * llm-face.ts). Resolved on every suggest call — never frozen at
     * construction — so a provider fiber that activates late or restarts is
     * picked up. Absent in deployments without a model backend; the suggest
     * endpoint then reports `llm-unavailable` instead of failing activation.
     */
    readonly getLlm?: () => LlmFace | undefined;
    readonly getAgentDefaultModel?: () => AgentDefaultModelFace | undefined;
    /** The session's durable model selection (projection next); undefined when
     * the session has never selected a model. */
    readonly getSessionModel?: (sessionId: string) => SessionModelSelection | undefined;
}
/**
 * Pick the primary remote from `git remote -v` output and parse its fetch URL.
 * Prefers `origin`; otherwise the first remote listed. Lines look like
 * `origin\thttps://…\t(fetch)` — only `(fetch)` rows are considered.
 */
export declare function parsePrimaryRemote(stdout: string): GitRemote | null;
export type WorkspaceResolution = {
    readonly ok: true;
    readonly root: string;
} | {
    readonly ok: false;
    readonly failure: GitSnapshotResult & {
        ok: false;
    };
};
/**
 * Resolve a directory root for the file browser, which must work outside a git
 * repository too. Inside a repo it is the work-tree top; otherwise it falls
 * back to the session's cwd (realpath'd) so directory listing / file preview
 * still function. Only a missing cwd is a hard failure.
 *
 * A selector that no longer names a repository reports the failure instead of
 * browsing something else, so the file tree can never disagree with the picker.
 * Failures that answer nothing about the selector — git missing — keep the cwd
 * fallback: every listing would fail otherwise, with no way back to the default.
 */
export declare function resolveBrowseRoot(deps: SnapshotDeps, sessionId: string, repo?: string): Promise<{
    ok: true;
    root: string;
    isGitRepo: boolean;
} | {
    ok: false;
    error: {
        code: GitErrorCode;
        message?: string;
    };
}>;
/** The session's cwd: the live session header first, then the persisted one. */
export declare function resolveSessionCwd(deps: SnapshotDeps, sessionId: string): Promise<{
    readonly ok: true;
    readonly cwd: string;
} | {
    readonly ok: false;
    readonly failure: GitSnapshotResult & {
        ok: false;
    };
}>;
/**
 * Resolve the git work-tree root for a session's cwd.
 *
 * 'repo' selects which repository (see GitRepoEntry): absent or '' keeps the
 * original behavior — git walks up from the cwd to the enclosing top, which may
 * be a parent of the cwd. A non-empty selector must name a work-tree *top*
 * inside the cwd: an ordinary subdirectory of a repository is rejected rather
 * than silently resolving to its parent, because the repository list only ever
 * offers tops.
 */
export declare function resolveWorkspace(deps: SnapshotDeps, sessionId: string, repo?: string): Promise<WorkspaceResolution>;
/**
 * Repositories a session's cwd offers: the repository the cwd belongs to (when
 * it does) plus — when `detectCheckouts` is on — every checkout below it: the
 * worktrees `git worktree list` certifies (unbounded in depth, and honest about
 * branches / locks / lost directories) and the nested repositories the
 * filesystem scan finds. The scan is filesystem-only — a '.git' entry is the
 * marker — so it still works when git cannot run at all. Both probes are off
 * with `detectCheckouts`: neither `git worktree list` nor the scan runs, and
 * the list is the cwd's own repository alone. `resultLimit` is the switcher's
 * ceiling for scanned repositories (tests shrink it).
 */
export declare function listSessionRepos(deps: SnapshotDeps, sessionId: string, detectCheckouts: boolean, resultLimit?: number): Promise<{
    readonly ok: true;
    readonly value: GitRepoList;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: GitErrorCode;
        readonly message?: string;
    };
}>;
/** Run one git command; a spawn-level failure returns { failure }. */
export declare function runCommand(runner: GitRunner, argv: readonly string[], cwd: string, _label: string, signal?: AbortSignal, stdinData?: string): Promise<{
    run: Awaited<ReturnType<GitRunner['run']>>;
} | {
    failure: unknown;
}>;
/**
 * Collapse a workspace-resolution failure into the `{ code, message }` shape
 * the run/query endpoints return. `GitFailure` already carries only endpoint
 * codes, so no membership test is needed (the previous per-endpoint ternary
 * that re-listed every code was always true — dead). `detail` becomes message.
 */
export declare function mapWorkspaceFailure(failure: GitSnapshotResult & {
    ok: false;
}): {
    code: GitErrorCode;
    message?: string;
};
/** Produce a full snapshot for a session. */
export declare function snapshotForSession(deps: SnapshotDeps, config: GitPanelConfig, sessionId: string, opts?: {
    readonly fullChanges?: boolean;
    readonly repo?: string;
}): Promise<GitSnapshotResult>;
/** Max mtime among changed files (epoch ms), capped for large sets. */
export declare function maxChangeMtime(deps: SnapshotDeps, root: string, changes: readonly GitChange[], cap?: number): Promise<number | null>;
