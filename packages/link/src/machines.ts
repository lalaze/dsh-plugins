/**
 * The machines this host can open: configured listener addresses, and the same tailnet user's computers found in
 * `tailscale status`. Each candidate is probed at its `/dsh-link/hello`; a tailnet computer is listed once it
 * answered, and stays listed (offline, with when it was last seen) for {@link RETAIN_MS} after.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Hello, MachineInfo } from './model.js';
import { describe, request } from './proxy.js';
import type { TailnetStatus } from './tailscale.js';

const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
const DESKTOP_OS = new Set(['macOS', 'linux', 'windows']);
/** A machine Tailscale calls offline gets this long to answer anyway. */
const OFFLINE_PROBE_MS = 3_000;
/**
 * A tailnet machine that is up but has had nothing of this plugin answering on its port (DSH or the plugin removed
 * there) is forgotten after this long; it shows up again by itself once the plugin answers. A DSH restart is shorter.
 */
const FORGET_REFUSED_MS = 10 * 60 * 1000;

/** A stable mount id for one listener URL. */
export const machineIdOf = (url: string) => `m${createHash('sha256').update(url).digest('hex').slice(0, 10)}`;

/** `http://host:port` with no path: what every candidate and the book are keyed by. */
export function normalizeUrl(text: string): string | undefined {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text.trim()) ? text.trim() : `http://${text.trim()}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch { return undefined; }
}

interface Candidate { url: string; source: 'tailnet' | 'static'; online: boolean; name?: string; os?: string; lastSeen?: number }

/** Who to probe this round. */
export function candidatesOf(status: TailnetStatus | undefined, port: number, statics: readonly string[], discover: boolean): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const text of statics) {
    const url = normalizeUrl(text);
    if (url) out.set(url, { url, source: 'static', online: true });
  }
  if (discover && status?.running) {
    for (const node of status.peers) {
      if (node.tagged || node.userId !== status.self.userId || !DESKTOP_OS.has(node.os)) continue;
      const ip = node.ips.find(address => !address.includes(':'));
      if (!ip) continue;
      const url = `http://${ip}:${port}`;
      if (!out.has(url)) out.set(url, { url, source: 'tailnet', online: node.online, name: node.name, os: node.os, ...(node.lastSeen ? { lastSeen: node.lastSeen } : {}) });
    }
  }
  return [...out.values()];
}

/** A hello probe's failure in a few words. */
export function probeReason(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'ECONNREFUSED') return 'no-listener';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'not-plugin') return 'not-plugin';
  if (code === 'forbidden') return 'forbidden';
  return describe(error);
}

export async function probeHello(url: string, timeoutMs = 6_000): Promise<Hello> {
  const answer = await request(new URL('/dsh-link/hello', url), { timeoutMs, maxBytes: 16 * 1024 });
  if (answer.status === 403 || answer.status === 421) throw Object.assign(new Error(`refused (${answer.status})`), { code: 'forbidden' });
  let hello: Partial<Hello> | undefined;
  try { hello = JSON.parse(answer.body.toString('utf8')) as Partial<Hello>; } catch { /* not ours */ }
  if (answer.status !== 200 || hello?.dshLink !== 1 || typeof hello.id !== 'string') throw Object.assign(new Error('not a DSH with this plugin'), { code: 'not-plugin' });
  return { dshLink: 1, id: hello.id, name: String(hello.name ?? ''), os: String(hello.os ?? ''), version: String(hello.version ?? '') };
}

interface Remembered { name: string; os: string; lastSeen: number }

export class MachineBook {
  private remembered = new Map<string, Remembered>();
  private current = new Map<string, MachineInfo>();
  private listeners = new Set<() => void>();

  constructor(private readonly file: string, private readonly selfId: () => string) {}

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Remembered>;
      this.remembered = new Map(Object.entries(raw).filter(([, value]) => Date.now() - value.lastSeen < RETAIN_MS));
    } catch { /* first start */ }
  }

  list(): MachineInfo[] { return [...this.current.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id: string): MachineInfo | undefined { return this.current.get(id); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /**
   * Probe every candidate and replace the list with what answered (and what is remembered). A machine Tailscale calls
   * offline is still asked, briefly, when this book knew it: Tailscale's flag is the coordination server's view, and a
   * machine whose Tailscale lost that server (seen with the MacBook Air on a relay) stays reachable over the tailnet.
   */
  async refresh(candidates: Candidate[], probe: (url: string, timeoutMs?: number) => Promise<Hello> = (url, timeoutMs) => probeHello(url, timeoutMs)): Promise<void> {
    const now = Date.now();
    const next = new Map<string, MachineInfo>();
    await Promise.all(candidates.map(async candidate => {
      const id = machineIdOf(candidate.url);
      const known = this.remembered.get(candidate.url);
      const base = { id, url: candidate.url, source: candidate.source } as const;
      if (!candidate.online) {
        const hello = known ? await probe(candidate.url, OFFLINE_PROBE_MS).catch(() => undefined) : undefined;
        if (hello && hello.id !== this.selfId()) {
          this.remembered.set(candidate.url, { name: hello.name || known!.name, os: hello.os || known!.os, lastSeen: now });
          next.set(id, { ...base, name: hello.name || known!.name, os: hello.os || known!.os, state: 'online', lastSeen: now, ...(hello.version ? { version: hello.version } : {}) });
        } else if (known) next.set(id, { ...base, name: known.name, os: known.os, state: 'offline', lastSeen: Math.max(known.lastSeen, candidate.lastSeen ?? 0) });
        return;
      }
      try {
        const hello = await probe(candidate.url);
        if (hello.id === this.selfId()) return;
        const name = hello.name || candidate.name || new URL(candidate.url).hostname;
        this.remembered.set(candidate.url, { name, os: hello.os || candidate.os || '', lastSeen: now });
        next.set(id, { ...base, name, os: hello.os || candidate.os || '', state: 'online', lastSeen: now, ...(hello.version ? { version: hello.version } : {}) });
      } catch (error) {
        // A tailnet computer that never answered is not a machine; a configured one is listed either way.
        if (candidate.source === 'tailnet' && !known) return;
        const reason = probeReason(error);
        if (candidate.source === 'tailnet' && (reason === 'no-listener' || reason === 'not-plugin') && now - known!.lastSeen > FORGET_REFUSED_MS) {
          this.remembered.delete(candidate.url);
          return;
        }
        next.set(id, { ...base, name: known?.name || candidate.name || new URL(candidate.url).host, os: known?.os || candidate.os || '', state: 'unreachable', reason, ...(known ? { lastSeen: known.lastSeen } : {}) });
      }
    }));
    const shape = (map: Map<string, MachineInfo>) => JSON.stringify([...map.values()].map(({ id, url, name, os, state, reason }) => [id, url, name, os, state, reason]).sort());
    const changed = shape(next) !== shape(this.current);
    this.current = next;
    this.save();
    if (changed) for (const listener of [...this.listeners]) listener();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.remembered), null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch { /* the list still works in memory */ }
  }
}
