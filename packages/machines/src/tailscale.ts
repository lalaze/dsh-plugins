/** The `tailscale` CLI: who this node is, who else is on the tailnet, and who an address belongs to. */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface TailnetNode {
  /** Stable node id, e.g. `n4u86tzd6121CNTRL`. */
  id: string;
  /** First label of the MagicDNS name, e.g. `lalazemac-mini`; the host name when there is none. */
  name: string;
  /** MagicDNS name without the trailing dot, '' when unknown. */
  dnsName: string;
  os: string;
  ips: string[];
  /** Owner's user id as the CLI prints it. Kept as text: the numbers do not fit a double. */
  userId: string;
  online: boolean;
  tagged: boolean;
  /** ms since the epoch; undefined when never seen or online. */
  lastSeen?: number;
}

export interface TailnetStatus { running: boolean; self: TailnetNode; peers: TailnetNode[] }

/** Where the CLI usually is: the standalone and App Store apps ship it inside the bundle. */
const CANDIDATES = ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

let found: Promise<string> | undefined;
/** @returns the CLI to run: the configured one, else the first candidate that answers `version`. */
export function tailscaleCli(configured: string): Promise<string> {
  if (configured) return Promise.resolve(configured);
  found ??= (async () => {
    for (const candidate of CANDIDATES) {
      if (candidate.startsWith('/')) { try { await access(candidate, constants.X_OK); } catch { continue; } }
      try { await run(candidate, ['version'], 4_000); return candidate; } catch { /* next */ }
    }
    found = undefined;
    throw new Error('the tailscale command was not found; set its path in the plugin settings');
  })();
  return found;
}

function run(cli: string, args: string[], timeout = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cli} ${args[0]}: ${(stderr || error.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

/** JSON with every user and node id quoted first: Tailscale ids are 17-digit integers. */
export function parseIds(text: string): unknown {
  return JSON.parse(text.replace(/"(UserID|User|ID)":\s*(-?\d+)/g, '"$1":"$2"'));
}

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

function nodeOf(raw: unknown): TailnetNode {
  const node = record(raw);
  const dnsName = str(node.DNSName).replace(/\.$/, '');
  const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [];
  const seen = Date.parse(str(node.LastSeen));
  const tags = node.Tags;
  return {
    id: str(node.ID), name: dnsName.split('.')[0] || str(node.HostName), dnsName, os: str(node.OS), ips,
    userId: str(node.UserID), online: node.Online === true, tagged: Array.isArray(tags) && tags.length > 0,
    ...(Number.isFinite(seen) && seen > 0 ? { lastSeen: seen } : {}),
  };
}

/** Read `tailscale status --json`. */
export function statusOf(text: string): TailnetStatus {
  const status = record(parseIds(text));
  return { running: status.BackendState === 'Running', self: nodeOf(status.Self), peers: Object.values(record(status.Peer)).map(nodeOf) };
}

export async function readStatus(configured: string): Promise<TailnetStatus> {
  return statusOf(await run(await tailscaleCli(configured), ['status', '--json']));
}

export interface Whois { userId: string; node: string }
/** Read `tailscale whois --json`: a tagged node's owner is the tag, which has no user profile. */
export function whoisOf(text: string): Whois | undefined {
  const answer = record(parseIds(text));
  const profile = record(answer.UserProfile);
  const node = record(answer.Node);
  const tags = node.Tags;
  if (Array.isArray(tags) && tags.length > 0) return undefined;
  const userId = str(profile.ID) || str(node.User);
  return userId ? { userId, node: str(node.Name).replace(/\.$/, '').split('.')[0] ?? '' } : undefined;
}

/** @returns the tailnet user behind an address, undefined for a tagged device or a non-tailnet address. */
export async function whois(configured: string, ip: string): Promise<Whois | undefined> {
  try { return whoisOf(await run(await tailscaleCli(configured), ['whois', '--json', ip], 5_000)); } catch { return undefined; }
}
