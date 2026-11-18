import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { UsageRecord } from './domain.js';

const MONTHLY_LEDGER = /^\d{4}-\d{2}\.jsonl$/;

const DRIVER_CLI: Record<string, string> = {
  claudeAgent: 'claude',
  codex: 'codex',
  grokAgent: 'grok',
  grok: 'grok',
  antigravityAgent: 'antigravity',
  piAgent: 'pi',
  geminiAgent: 'gemini',
  kimiAgent: 'kimi',
  qwenAgent: 'qwen',
  opencodeGo: 'opencode',
  cursorAgent: 'cursor',
  droidAgent: 'droid',
  copilotAgent: 'copilot',
  commandCodeAgent: 'command-code',
  kiroAgent: 'kiro',
  clineAgent: 'cline',
  hermesAgent: 'hermes',
  deepseekAgent: 'deepseek',
  museCode: 'muse-code',
};

/** Maps an OpenMausBot driver and instance to a `mausbot-<engine>` provider ID. */
export function mausbotProvider(driverKind?: unknown, instanceId?: unknown): string {
  const driver = typeof driverKind === 'string' ? driverKind.trim() : '';
  const instance = typeof instanceId === 'string' ? instanceId.trim() : '';
  let engine: string;
  if (driver === 'openai-compat') engine = instance === 'openai' || instance === 'openrouter' ? instance : 'openai-compat';
  else engine = DRIVER_CLI[driver] ?? (driver.replace(/Agent$/, '').toLowerCase() || instance.toLowerCase() || 'unknown');
  const clean = engine.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `mausbot-${clean}`;
}

/** Workspace label for an OpenMausBot bot: `MausBot` for the default bot, `MausBot · <name>` for named bots. */
export function mausbotWorkspace(botName?: string): string {
  const trimmed = botName?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'mausbot') return 'MausBot';
  return `MausBot · ${trimmed}`.slice(0, 1024);
}

interface ParsedEntry {
  botId: string;
  botName?: string;
  record: Omit<UsageRecord, 'workspace'>;
}

interface FileCache {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Byte offset after the last `\n`-terminated line committed to `committed`. */
  offset: number;
  committed: ParsedEntry[];
  /** Any complete line after `offset` that lacks a trailing newline yet. */
  trailing: ParsedEntry[];
}

const nonNegInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.trunc(value)) ? Math.trunc(value) : undefined;

const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Parses one OpenMausBot `usage/YYYY-MM.jsonl` row. In OpenMausBot's ledger, `input` is total input (including
 * `cachedInput` and `cacheWrite`), whereas `UsageRecord.usage.inputTokens` is uncached input only.
 */
export function parseMausbotLine(line: string, id: string): ParsedEntry | undefined {
  if (!line) return undefined;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch { return undefined; }
  if (!validTime(raw.at) || typeof raw.botId !== 'string' || !raw.botId || typeof raw.model !== 'string' || !raw.model) return undefined;
  const totalInput = nonNegInt(raw.input), outputTokens = nonNegInt(raw.output);
  if (totalInput === undefined || outputTokens === undefined) return undefined;
  const rawRead = nonNegInt(raw.cachedInput) ?? 0;
  const rawWrite = nonNegInt(raw.cacheWrite) ?? 0;
  const rawReasoning = nonNegInt(raw.reasoning) ?? 0;

  let usage: TokenUsage | undefined;
  if (raw.usageStatus !== 'unavailable' && (totalInput > 0 || outputTokens > 0 || rawRead > 0 || rawWrite > 0)) {
    const cacheReadTokens = Math.min(rawRead, totalInput);
    const cacheWriteTokens = Math.min(rawWrite, totalInput - cacheReadTokens);
    const inputTokens = totalInput - cacheReadTokens - cacheWriteTokens;
    const reasoningTokens = Math.min(rawReasoning, outputTokens);
    usage = {
      inputTokens,
      outputTokens,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    };
  }

  const startedAt = validTime(raw.startedAt) ? raw.startedAt : raw.at;
  const endedAt = validTime(raw.endedAt) ? raw.endedAt : raw.at;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const outcome = raw.outcome && typeof raw.outcome === 'object' ? (raw.outcome as { status?: unknown }).status : undefined;
  const status: UsageRecord['status'] = outcome === 'interrupted' ? 'cancelled' : outcome === 'error' ? 'error' : 'completed';
  const triggerKind = raw.trigger && typeof raw.trigger === 'object' ? (raw.trigger as { kind?: unknown }).kind : undefined;
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : '';
  const memory = threadId.startsWith('memory-');
  const sessionId = threadId && !memory && threadId.length <= 900 ? `mausbot:${threadId}` : undefined;
  const purpose = memory ? 'memory' : triggerKind === 'routine' ? 'routine' : triggerKind === 'bot' ? 'delegation' : triggerKind === 'helper' ? 'helper' : 'conversation';
  const botName = typeof raw.botName === 'string' && raw.botName.trim() ? raw.botName.trim() : undefined;

  return {
    botId: raw.botId,
    ...(botName ? { botName } : {}),
    record: {
      id,
      startedAt,
      provider: mausbotProvider(raw.driverKind, raw.instanceId),
      model: raw.model,
      ...(sessionId ? { sessionId } : {}),
      purpose,
      status,
      durationMs,
      ...(usage ? { usage } : {}),
    },
  };
}

function parseLines(buf: Buffer, baseOffset: number, file: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const end = i > start && buf[i - 1] === 0x0d ? i - 1 : i;
    if (end > start) {
      const entry = parseMausbotLine(buf.subarray(start, end).toString('utf8'), `mausbot:${file}:${baseOffset + start}`);
      if (entry) out.push(entry);
    }
    start = i + 1;
  }
  return out;
}

/**
 * Incrementally reads OpenMausBot's append-only monthly usage ledgers (`<dataDir>/usage/YYYY-MM.jsonl`).
 * Missing directories return no records, so machines that do not run OpenMausBot stay quiet.
 */
export class MausbotUsage {
  private readonly usageDir?: string;
  private files = new Map<string, FileCache>();
  private snapshot: UsageRecord[] = [];
  private inflight?: Promise<readonly UsageRecord[]>;

  constructor(dataDir?: string) {
    const trimmed = dataDir?.trim();
    this.usageDir = trimmed ? join(trimmed, 'usage') : undefined;
  }

  records(): Promise<readonly UsageRecord[]> {
    if (!this.usageDir) return Promise.resolve([]);
    return this.inflight ??= this.refresh().finally(() => { this.inflight = undefined; });
  }

  private async refresh(): Promise<readonly UsageRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.usageDir!)).filter(name => MONTHLY_LEDGER.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        this.files.clear();
        this.snapshot = [];
        return this.snapshot;
      }
      return this.snapshot;
    }

    let changed = names.length !== this.files.size;
    const seen = new Set(names);
    for (const key of this.files.keys()) if (!seen.has(key)) { this.files.delete(key); changed = true; }

    for (const name of names) {
      const path = join(this.usageDir!, name);
      let info;
      try { info = await stat(path); } catch { if (this.files.delete(name)) changed = true; continue; }
      const cached = this.files.get(name);
      if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) continue;
      changed = true;
      const append = cached !== undefined && cached.ino === info.ino && info.size > cached.size;
      const from = append ? cached.offset : 0;
      const committed = append ? [...cached.committed] : [];
      let offset = from;
      let trailing: ParsedEntry[] = [];
      if (info.size > from) {
        const length = info.size - from;
        const buf = Buffer.allocUnsafe(length);
        let read = 0;
        const handle = await open(path, 'r');
        try {
          while (read < length) {
            const { bytesRead } = await handle.read(buf, read, length - read, from + read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
        } finally { await handle.close(); }
        const slice = buf.subarray(0, read);
        const lastNl = slice.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          committed.push(...parseLines(slice.subarray(0, lastNl + 1), from, name));
          offset = from + lastNl + 1;
        }
        const restStart = lastNl + 1;
        if (restStart < slice.length) {
          const tail = slice.subarray(restStart).toString('utf8').replace(/\r$/, '');
          const entry = parseMausbotLine(tail, `mausbot:${name}:${from + restStart}`);
          if (entry) trailing = [entry];
        }
      }
      this.files.set(name, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, offset, committed, trailing });
    }

    if (!changed) return this.snapshot;

    const botNames = new Map<string, string>();
    for (const name of names) {
      const file = this.files.get(name);
      if (!file) continue;
      for (const entry of file.committed) if (entry.botName) botNames.set(entry.botId, entry.botName);
      for (const entry of file.trailing) if (entry.botName) botNames.set(entry.botId, entry.botName);
    }

    const next: UsageRecord[] = [];
    for (const name of names) {
      const file = this.files.get(name);
      if (!file) continue;
      for (const entry of [...file.committed, ...file.trailing]) {
        next.push({ ...entry.record, workspace: mausbotWorkspace(botNames.get(entry.botId) ?? entry.botName) });
      }
    }
    this.snapshot = next;
    return this.snapshot;
  }
}
