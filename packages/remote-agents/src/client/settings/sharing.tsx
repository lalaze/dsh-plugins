import React, { useEffect, useState } from 'react';
import type { Dashboard } from '../../core/domain.js';
import type { SharingCatalog } from '../../sharing/sharing.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';

type Catalog = SharingCatalog & { errors: Record<string, string> };

/** What DSH shares with every remote CLI: MCP servers through DSH (off by default) and skills (on by default). */
export function SharingSettings({ dashboard }: { dashboard: Dashboard }) {
  const [catalog, setCatalog] = useState<Catalog>(), [error, setError] = useState(''), [busy, setBusy] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<Catalog>('sharing', {}, controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); },
      e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, []);
  const toggle = (kind: 'mcp' | 'skill', name: string, shared: boolean) => {
    setBusy(`${kind}:${name}`); setError('');
    void api<Catalog>('setSharing', { kind, name, shared }).then(setCatalog, e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(''));
  };
  const hosts = new Map(dashboard.hosts.map(host => [host.id, host.label]));
  return <div className="ra-page ra-sharing">
    <h2>{ui('Share with remote CLIs')}</h2>
    <p className="ra-muted">{ui('Remote CLIs started afterwards receive what is selected here. Antigravity cannot receive them.')}</p>
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {catalog && Object.entries(catalog.errors).map(([hostId, message]) => <div key={hostId} className="ra-banner" data-tone="error" role="alert">
      {ui('{host}: DSH MCP servers are unreachable from this machine. {error}', { host: hosts.get(hostId) ?? hostId, error: localizeError(message) })}</div>)}
    {!catalog ? !error && <div className="ra-empty" role="status">{ui('Loading…')}</div> : <>
      <fieldset className="ra-share-list" disabled={!!busy}>
        <legend>{ui('MCP servers')}</legend>
        <p className="ra-muted">{ui('Calls run in DSH on this computer with the conversation that started the CLI, so DSH permissions and approvals apply and credentials stay here. Off by default.')}</p>
        {!catalog.available.mcp ? <p className="ra-muted">{ui('DSH tools are unavailable.')}</p>
          : !catalog.mcp.length ? <p className="ra-muted">{ui('No MCP servers are configured in DSH.')}</p>
          : catalog.mcp.map(server => <label key={server.name}><input type="checkbox" checked={server.shared} onChange={e => toggle('mcp', server.name, e.target.checked)} />
            <span className="ra-share-name">{server.name}</span><span className="ra-muted">{ui('{count} tools', { count: server.tools })}</span></label>)}
      </fieldset>
      <fieldset className="ra-share-list" disabled={!!busy}>
        <legend>{ui('Skills')}</legend>
        <p className="ra-muted">{ui('Copied to each machine; Claude Code loads them as the dsh plugin, other CLIs through a load_skill tool. On by default.')}</p>
        {!catalog.available.skills ? <p className="ra-muted">{ui('DSH skills are unavailable.')}</p>
          : !catalog.skills.length ? <p className="ra-muted">{ui('No personal skills are installed in DSH.')}</p>
          : catalog.skills.map(skill => <label key={skill.name}><input type="checkbox" checked={skill.shared} onChange={e => toggle('skill', skill.name, e.target.checked)} />
            <span className="ra-share-name">{skill.name}</span><span className="ra-muted ra-share-description" title={skill.description}>{skill.description}</span></label>)}
      </fieldset>
    </>}
  </div>;
}
