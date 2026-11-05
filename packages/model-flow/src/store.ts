/** The models chosen in settings. Nothing about a running flow is saved: it ends with DSH. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_ROUNDS, MAX_ROUNDS } from './line.js';
import type { Route } from './routes.js';

export interface FlowConfig { plan?: Route; implement?: Route; review?: Route; rounds: number }

function routeFrom(value: unknown): Route | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { provider, model, effort, label } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return undefined;
  return { provider, model, label: typeof label === 'string' && label ? label : model, ...(typeof effort === 'string' && effort ? { effort } : {}) };
}
export function configFrom(value: unknown): FlowConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rounds = Number(raw.rounds), plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
  return {
    ...(plan ? { plan } : {}), ...(implement ? { implement } : {}), ...(review ? { review } : {}),
    rounds: Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS ? rounds : DEFAULT_ROUNDS,
  };
}
export class FlowStore {
  config: FlowConfig = { rounds: DEFAULT_ROUNDS };
  constructor(private readonly path: string) {}
  async open(): Promise<void> {
    try { this.config = configFrom(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async save(next: FlowConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    this.config = next;
  }
}
