/**
 * What another plugin's page adds to a flow's card. A plugin that starts flows tags them `<prefix>:<its own words>`, and
 * registers under that prefix: it then draws the tagged cards itself, around the same card everybody else sees. It can
 * also draw the rows its own server answered a /flow line with, when the line was handed over to it.
 */
import { useSyncExternalStore } from 'react';
import type React from 'react';
import type { CardState, LiveCard, StepStatus } from '../shared.js';

/** One flow as its card draws it. Everything the card can do comes along, so whoever draws it needs nothing else. */
export interface FlowView {
  card: CardState & Partial<Pick<LiveCard, 'elapsed' | 'activity'>>;
  /** The flow is running, here and now. */
  active: boolean;
  /** Left running by a DSH that stopped. */
  interrupted?: boolean;
  report?: string;
  /** Ends the flow; absent when it cannot be ended from this card. */
  stop?(): void;
  stopping?: boolean;
  /** A finished step's full result, for a card that does not carry it. */
  stepBody?(index: number): Promise<string | null>;
  /** False where the steps' own conversations cannot be opened, as for a flow another DSH runs. */
  canOpen?: boolean;
}
/** A step that is not a model's: something the plugin does after the flow, at the end of the progress bar. */
export interface Stage { label: string; status: StepStatus | 'pending' | 'skipped' }
export interface ViewExtras {
  /** In place of the flow's own words at the top of the card. `clock` in milliseconds; null hides it. */
  head?: { status: StepStatus; title: string; detail?: string; clock?: number | null };
  stages?: readonly Stage[];
  /** Above everything else: what the card is about, where the conversation does not already say. */
  caption?: React.ReactNode;
  /** Under the report. */
  children?: React.ReactNode;
}
export interface CommandNode { commandId: string; name?: string | null; args?: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null }
export interface CardExtension {
  /** Draws a tagged flow's card, usually as `View` with more around it. */
  Card?: React.ComponentType<{ tag: string; flow: FlowView }>;
  /** Whether a /flow row's saved text is this plugin's to draw. */
  claims?(text: string): boolean;
  Row?: React.ComponentType<{ node: CommandNode }>;
}
/** The client service `modelFlowCard`. */
export interface ModelFlowCard {
  readonly version: 1;
  View: React.ComponentType<FlowView & ViewExtras>;
  /** Returns how to take the extension away again. Registering a prefix again replaces the earlier one. */
  extend(prefix: string, extension: CardExtension): () => void;
}

const extensions = new Map<string, CardExtension>(), listeners = new Set<() => void>();
let revision = 0;
const changed = () => { revision++; for (const listener of listeners) listener(); };
export function extend(prefix: string, extension: CardExtension): () => void {
  if (!/^[a-z][a-z0-9-]{0,30}$/u.test(prefix)) throw new Error('A prefix is lowercase letters, digits and dashes');
  extensions.set(prefix, extension); changed();
  return () => { if (extensions.get(prefix) === extension) { extensions.delete(prefix); changed(); } };
}
const watch = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Cards drawn before a plugin registered are drawn again once it has. */
export const useExtensions = (): number => useSyncExternalStore(watch, () => revision, () => revision);
export const extensionFor = (tag: string | undefined): CardExtension | undefined => tag ? extensions.get(tag.slice(0, Math.max(0, tag.indexOf(':')))) : undefined;
export function claimant(text: string): CardExtension | undefined {
  for (const extension of extensions.values()) {
    try { if (extension.Row && extension.claims?.(text)) return extension; } catch { /* Another plugin's mistake is not this row's. */ }
  }
  return undefined;
}
