import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatProject } from '../../src/core/domain.js';
import { installCustomModelLabels } from '../../src/client/composer/custom-model-label.js';

/** Replay the custom composer markup captured from the desktop, with real React text reconciliation. */
export function customModelFixture() {
  const element = document.createElement('div'); element.dataset.customModelFixture = '';
  element.style.cssText = 'position:fixed;bottom:100px;right:20px;padding:12px;background:#303030;color:#fff;z-index:10';
  document.body.append(element); const root = createRoot(element);
  const catalogs: ChatProject[] = [{ id: 'ubuntu', hostId: 'ubuntu', cwd: '/srv/project', label: 'ubuntu-claude', providers: [
    { id: 'claude', label: 'Claude', status: 'ready', modes: [], models: [{ id: 'opus', label: 'Opus 5.5' }, { id: 'other', label: 'Auto · Fast' }] },
    { id: 'codex', label: 'Codex', status: 'ready', modes: [], models: [{ id: 'gpt', label: 'GPT-5.5', serviceTiers: [{ id: 'fast', label: 'Fast' }] }] },
  ] }];
  let clicks = 0;
  const stop = installCustomModelLabels(async () => catalogs);
  const render = (name = 'Opus 5.5 · ubuntu-claude', effort = 'high') => root.render(<button type="button" className="codexModelSelectTrigger" aria-label={name} aria-haspopup="menu" aria-expanded="false" title={name} onClick={() => clicks++}>
    <span className="codexModelSelectLabel">{name}</span><span className="codexModelSelectEffort">{effort}</span>
    <svg className="codexModelSelectChevron" width="14" height="14" aria-hidden="true"><path d="M4 6L8 10L12 6" /></svg>
  </button>);
  render();
  return { render, stop, clicks: () => clicks, unmount: () => { stop(); root.unmount(); element.remove(); } };
}
