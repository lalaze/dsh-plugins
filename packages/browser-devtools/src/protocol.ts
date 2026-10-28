/** The window and DSH renderer have separate credentials; only DSH can answer commands. */
export interface PageState {
  url: string;
  title: string;
  revision: number;
  ready: boolean;
  locale: 'en' | 'zh';
  dark: boolean;
}
export interface Command { id: string; code: string; gesture: boolean; revision: number }
export interface Reply { id: string; value?: unknown; error?: string }
export interface SessionKey { id: string; token: string }
export class BridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('Invalid request');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || value.length > max) throw new BridgeError('Invalid text');
  return value;
}
export function pageState(value: unknown): PageState {
  const v = record(value);
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || typeof v.ready !== 'boolean'
    || typeof v.dark !== 'boolean' || !['en', 'zh'].includes(String(v.locale))) throw new BridgeError('Invalid page state');
  return { url: string(v.url), title: string(v.title, 1024), revision: Number(v.revision), ready: v.ready, dark: v.dark, locale: v.locale as 'en' | 'zh' };
}
