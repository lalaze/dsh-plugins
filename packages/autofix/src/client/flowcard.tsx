/**
 * The flow's own card, from dsh-model-flow's page (client service `modelFlowCard`, since its 0.1.11): a task is drawn
 * with it, so a fix and a /flow show their progress the same way. Without it a task is drawn plainly.
 */
import type React from 'react';
import { useSyncExternalStore } from 'react';
import type { FlowEnd, FlowStep } from '../conversations.js';

type StepStatus = 'running' | 'done' | 'passed' | 'sentBack' | 'noVerdict' | 'failed' | 'stopped';
/** One flow as its card draws it; the names are dsh-model-flow's. */
export interface FlowView {
  card: { parentId: string; zh: boolean; rounds: number; planned?: boolean; steps: FlowStep[]; end?: FlowEnd; tag?: string; elapsed?: number; activity?: string };
  active: boolean;
  interrupted?: boolean;
  report?: string;
  stop?(): void;
  stopping?: boolean;
  stepBody?(index: number): Promise<string | null>;
  canOpen?: boolean;
}
export interface Stage { label: string; status: StepStatus | 'pending' | 'skipped' }
export interface ViewExtras {
  head?: { status: StepStatus; title: string; detail?: string; clock?: number | null };
  stages?: readonly Stage[];
  caption?: React.ReactNode;
  children?: React.ReactNode;
}
export interface CardExtension {
  Card?: React.ComponentType<{ tag: string; flow: FlowView }>;
  claims?(text: string): boolean;
  Row?: React.ComponentType<{ node: never }>;
}
export interface ModelFlowCard {
  readonly version: number;
  View: React.ComponentType<FlowView & ViewExtras>;
  extend(prefix: string, extension: CardExtension): () => void;
}

let current: ModelFlowCard | undefined;
const listeners = new Set<() => void>();
const watch = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** The card to draw tasks with, once Model flow's page offers it; cards drawn before then are drawn again. */
export const useFlowCard = (): ModelFlowCard | undefined => useSyncExternalStore(watch, () => current, () => current);

/**
 * Keeps this plugin registered with whatever Model flow's page offers right now: that plugin may load later than this
 * one, and may be updated while the page is open.
 */
export function followFlowCard(lookup: () => unknown, extension: CardExtension, everyMs = 3000): () => void {
  let undo: (() => void) | undefined;
  const look = () => {
    let found: ModelFlowCard | undefined;
    try { const value = lookup() as ModelFlowCard | undefined; found = value && typeof value.View === 'function' && typeof value.extend === 'function' ? value : undefined; } catch { /* Not there. */ }
    if (found === current) return;
    try { undo?.(); } catch { /* It is gone already. */ }
    undo = undefined; current = found;
    try { undo = found?.extend('autofix', extension); } catch (error) { console.warn('[dsh-autofix] Could not add to the flow card', error); }
    for (const listener of listeners) listener();
  };
  look();
  const timer = setInterval(look, everyMs);
  return () => {
    clearInterval(timer);
    try { undo?.(); } catch { /* It is gone already. */ }
    current = undefined;
    for (const listener of listeners) listener();
  };
}
/** For tests: the card as if Model flow's page had offered it. */
export function setFlowCard(card: ModelFlowCard | undefined): void { current = card; for (const listener of listeners) listener(); }
