import type { UsageRecord } from './domain.js';
/** Maps an OpenMausBot driver and instance to a `mausbot-<engine>` provider ID. */
export declare function mausbotProvider(driverKind?: unknown, instanceId?: unknown): string;
/** Workspace label for an OpenMausBot bot: `MausBot` for the default bot, `MausBot · <name>` for named bots. */
export declare function mausbotWorkspace(botName?: string): string;
interface ParsedEntry {
    botId: string;
    botName?: string;
    record: Omit<UsageRecord, 'workspace'>;
}
/**
 * Parses one OpenMausBot `usage/YYYY-MM.jsonl` row. In OpenMausBot's ledger, `input` is total input (including
 * `cachedInput` and `cacheWrite`), whereas `UsageRecord.usage.inputTokens` is uncached input only.
 */
export declare function parseMausbotLine(line: string, id: string): ParsedEntry | undefined;
/**
 * Incrementally reads OpenMausBot's append-only monthly usage ledgers (`<dataDir>/usage/YYYY-MM.jsonl`).
 * Missing directories return no records, so machines that do not run OpenMausBot stay quiet.
 */
export declare class MausbotUsage {
    private readonly usageDir?;
    private files;
    private snapshot;
    private inflight?;
    constructor(dataDir?: string);
    records(): Promise<readonly UsageRecord[]>;
    private refresh;
}
export {};
