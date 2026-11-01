/**
 * Groups (dsh-workspace-tags tags) shared between machines, merged field by field.
 *
 * Every field is a register: a value, the hybrid-clock stamp of the write that set it, and the device that wrote it.
 * A merge keeps the later write. When both machines changed the same field since they last agreed on it, the later
 * write still wins, so both converge, but the other value is kept as a conflict for the user to pick from.
 *
 * Register keys:
 * - `tag|<tagId>|name`, `tag|<tagId>|color`, `tag|<tagId>|order`, `tag|<tagId>|deleted`
 * - `assign|<tagId>|<device>:<workspace>`: whether the workspace has the tag
 * - `link|<ref>|<ref>`: whether two workspaces of different machines are the same project (refs sorted)
 */
import type { GroupConflict, GroupsView, GroupTag } from '../shared/protocol.js';
export interface Register {
    v: unknown;
    t: string;
    d: string;
}
export type Registers = Record<string, Register>;
/** dsh-workspace-tags' state; kept structurally so this package does not depend on it. */
export interface TagState {
    tags: {
        id: string;
        name: string;
        color: string;
    }[];
    assignments: Record<string, string[]>;
}
/** Hybrid logical clock: wall time when it moves forward, a counter otherwise. Stamps sort as strings. */
export declare class Clock {
    private readonly deviceId;
    private readonly time;
    private ms;
    private counter;
    constructor(deviceId: string, last?: string, time?: () => number);
    now(): string;
    /** Move past a stamp seen from another machine, so this machine's next write sorts after it. */
    observe(stamp: string): void;
    last(): string;
    private format;
}
interface StoredConflict extends GroupConflict {
    stamps: [string, string];
}
export interface GroupsData {
    registers: Registers;
    /** Per peer, the stamp of each register both machines last agreed on. */
    agreed: Record<string, Record<string, string>>;
    conflicts: Record<string, StoredConflict>;
    /** The tags state this machine last wrote to or read from dsh-workspace-tags. */
    projected?: TagState;
    clock?: string;
}
export declare const emptyGroups: () => GroupsData;
export declare const linkKey: (a: string, b: string) => string;
export declare class Groups {
    readonly data: GroupsData;
    private readonly deviceId;
    readonly clock: Clock;
    constructor(data: GroupsData, deviceId: string, deviceNames?: () => Record<string, string>);
    private readonly names;
    private write;
    /** Set one register from this machine, e.g. a tag on another machine's workspace. Returns whether it changed. */
    set(key: string, value: unknown): boolean;
    /**
     * Record what changed in this machine's dsh-workspace-tags since it was last read or written. Only assignments of
     * this machine's own workspaces are taken from it.
     * @returns whether any register changed.
     */
    observeLocal(current: TagState): boolean;
    /** Registers to send to a peer. */
    registers(): Registers;
    /**
     * Merge a peer's registers.
     * @returns whether anything here changed.
     */
    merge(peerId: string, remote: Registers): boolean;
    /** Forget what was agreed with a machine that is no longer paired. */
    forgetPeer(peerId: string): void;
    /** Pick a conflict's value. Keeping the current value also counts as a new write, so the other machine settles too. */
    resolve(key: string, useOther: boolean): boolean;
    /** Merged tags in display order, with names made unique the way dsh-workspace-tags requires. */
    tags(): GroupTag[];
    /** Workspace reference → tag ids, for every machine's workspaces. */
    assignments(): Record<string, string[]>;
    links(): [string, string][];
    /** The state dsh-workspace-tags should hold here: every merged tag, and this machine's own workspaces' assignments. */
    project(): TagState;
    /** Note what was written to dsh-workspace-tags, so it is not mistaken for a local edit. */
    projected(state: TagState): void;
    view(tagsPlugin: boolean): GroupsView;
}
export {};
