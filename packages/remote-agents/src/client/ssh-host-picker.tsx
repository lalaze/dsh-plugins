import React, { useEffect, useState } from 'react';
import type { Host, SshConfigHost, SshConfigHosts } from '../domain.js';
import { api } from './api.js';
import { localizeError, ui } from './i18n.js';

export function SshHostPicker({ hosts, connection, disabled, select }: { hosts: Host[]; connection: string; disabled: boolean; select: (host: SshConfigHost) => void }) {
  const [config, setConfig] = useState<SshConfigHosts>({ hosts: [], warnings: [] });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void api<SshConfigHosts>('sshConfig', {}, controller.signal).then(value => { if (!controller.signal.aborted) setConfig(value); })
      .catch(error => { if (!controller.signal.aborted) setError(localizeError(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const selected = config.hosts.some(host => host.connection === connection) ? connection : '';
  return <div className="ra-ssh-config">
    <div className="ra-actions" style={{ alignItems: 'end' }}>
      <label className="ra-field" style={{ flex: '1 1 220px', minWidth: 0 }}>{ui('SSH config host')}
        <select aria-label={ui('SSH config host')} disabled={disabled || loading || !config.hosts.length} value={selected} onChange={event => { const host = config.hosts.find(host => host.connection === event.target.value); if (host) select(host); }}>
          <option value="">{ui(loading ? 'Loading SSH config…' : 'Choose an SSH alias…')}</option>
          {config.hosts.map(host => { const saved = hosts.some(saved => saved.connection === host.connection); return <option value={host.connection} key={host.alias} disabled={saved}>{host.alias}{saved ? ` · ${ui('Already saved')}` : ''}</option>; })}
        </select>
      </label>
      <button type="button" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>{ui('Refresh SSH config')}</button>
    </div>
    <p className="ra-foot">{ui('Choose a Host alias from this DSH machine’s SSH config. SSH keeps its user, port, key and jump-host settings.')}</p>
    {!loading && !error && !config.hosts.length && <p className="ra-muted" role="status">{ui('No concrete Host aliases found in SSH config. You can enter a connection below.')}</p>}
    {error && <p className="ra-notice" role="alert">{error}</p>}
    {config.warnings.map(warning => <p className="ra-notice" role="status" key={warning}>{localizeError(warning)}</p>)}
  </div>;
}
