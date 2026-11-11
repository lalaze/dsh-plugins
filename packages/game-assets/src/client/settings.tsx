import React, { useEffect, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import type { TabMode } from '../domain.js';
import { i18n, localizeError, ui } from './i18n.js';
import { chooseMode, chooseProject, ensure, loadMode, useProject, workspaces } from './projects.js';
import { styles } from './styles.js';

type Choice = 'auto' | 'show' | 'hide';
const nameOf = (cwd: string) => cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd;

function WorkspaceRow({ sessionId, cwd, onError }: { sessionId: string; cwd: string; onError(message: string): void }) {
  const { status } = useProject(sessionId);
  const choice: Choice = status?.override === true ? 'show' : status?.override === false ? 'hide' : 'auto';
  const change = (next: Choice) => { void chooseProject(sessionId, next === 'auto' ? null : next === 'show').then(() => onError(''), error => onError(localizeError(error))); };
  return <div className="ga-frow ga-wrow" role="row">
    <span role="cell" className="ga-wname" title={cwd}><b>{nameOf(cwd)}</b>
      <span className="ga-dim">{!status ? ui('Loading…') : status.engine ? ui('{engine} project', { engine: status.engine }) : ui('No game engine found')}</span>
    </span>
    <span role="cell" className="ga-meta">{status && <><i className="ga-dot" data-on={status.game || undefined} />{ui(status.game ? 'Tab shown' : 'Tab hidden')}</>}</span>
    <select role="cell" className="ga-select" aria-label={ui('Assets tab in {name}', { name: nameOf(cwd) })} disabled={!status} value={choice} onChange={event => change(event.target.value as Choice)}>
      <option value="auto">{ui('Automatic')}</option><option value="show">{ui('Always show')}</option><option value="hide">{ui('Never show')}</option>
    </select>
  </div>;
}

/** The plugin's settings on its detail page: where the Assets tab appears, and the choice for each open workspace. */
export function TabSettings() {
  useLocale(i18n);
  const { mode } = useProject(undefined), [error, setError] = useState('');
  const list = workspaces();
  useEffect(() => { void loadMode(); for (const { sessionId } of workspaces()) void ensure(sessionId); }, [list.length]);
  const pick = (next: TabMode) => { void chooseMode(next).then(() => setError(''), e => setError(localizeError(e))); };
  return <section className="ga-root ga-settings"><style>{styles}</style>
    <p className="ga-dim">{ui('The Assets tab appears beside Chat only in conversations whose workspace is a game project: one that declares a game engine such as Phaser, PixiJS, Godot or Unity.')}</p>
    <div className="ga-modes" role="radiogroup" aria-label={ui('Show the Assets tab')}>
      {(['games', 'all'] as const).map(value => <label key={value}>
        <input type="radio" name="ga-mode" checked={(mode ?? 'games') === value} disabled={mode === undefined} onChange={() => pick(value)} />
        {ui(value === 'games' ? 'In game projects only' : 'In every conversation')}
      </label>)}
    </div>
    {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
    {list.length > 0 && <>
      <h4>{ui('Workspaces')}</h4>
      <div className="ga-folders" role="table">{list.map(entry => <WorkspaceRow key={entry.cwd} {...entry} onError={setError} />)}</div>
    </>}
  </section>;
}
