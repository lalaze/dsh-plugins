import type React from 'react';
import { symbols } from '@deepseek-ai/cordis';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { setModelDirectories, type ModelDirectories } from '@dsh-plugins/remote-core/client/current-model.js';
import { offerWorktreeTab } from '@dsh-plugins/remote-core/client/worktree-tab.js';
import type { WorktreeProject } from '../worktrees.js';
import { api } from './api.js';
import { installLocale } from './i18n.js';
import { installShellMenu } from './shell-menu.js';
import { installTerminalPreference } from './terminal-shell.js';
import { installTuiSessions } from './tui.js';
import { installTuiActivity } from './tui-activity.js';
import { ProjectFlow } from './worktree.js';

export interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}

export const name = 'dsh-remote-terminals-client';
// The desktop language bridge initializes asynchronously. Wait for it before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  installTuiSessions(ctx);
  installTuiActivity(ctx);
  installTerminalPreference(ctx);
  ctx.effect(installShellMenu);
  ctx.inject?.(['modelDirectories'], scoped => scoped.effect(() => {
    // Read through the service itself: this plugin's proxy would resolve dependencies from our context.
    const service = (scoped as unknown as { modelDirectories: ModelDirectories }).modelDirectories;
    setModelDirectories((service as unknown as Record<symbol, ModelDirectories | undefined>)[symbols.original] ?? service);
    return () => setModelDirectories(undefined);
  }));
  // Remote Agents' Add workspace dialog shows this tab when it is offered.
  ctx.effect(() => offerWorktreeTab({ projects: signal => api<WorktreeProject[]>('worktreeProjects', {}, signal), Flow: ProjectFlow }));
}
