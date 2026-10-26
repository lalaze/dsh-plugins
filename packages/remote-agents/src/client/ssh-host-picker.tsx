import React, { useEffect, useState } from 'react';
import type { Host, SshConfigHost, SshConfigHosts } from '../domain.js';
import { api } from './api.js';
import { localizeError, ui } from './i18n.js';
import { SshAliasSelect } from './ssh-alias-select.js';

export function SshHostPicker({ hosts, connection, disabled, select }: { hosts: Host[]; connection: string; disabled: boolean; select: (host: SshConfigHost) => void }) {
  const [config, setConfig] = useState<SshConfigHosts>({ hosts: [], warnings: [] });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void api<SshConfigHosts>('sshConfig', {}, controller.signal).then(value => { if (!controller.signal.aborted) setConfig(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return <div className="ra-ssh-config">
    <div className="ra-actions" style={{ alignItems: 'end' }}>
      <SshAliasSelect options={config.hosts} hosts={hosts} connection={connection} disabled={disabled} loading={loading} select={select} />
      <button type="button" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>{ui('Refresh SSH config')}</button>
    </div>
    <p className="ra-foot">{ui('Choose a Host alias from this DSH machine’s SSH config. SSH keeps its user, port, key and jump-host settings.')}</p>
    {!loading && !error && !config.hosts.length && <p className="ra-muted" role="status">{ui('No concrete Host aliases found in SSH config. You can enter a connection below.')}</p>}
    {error && <p className="ra-notice" role="alert">{localizeError(error)}</p>}
    {config.warnings.map(warning => <p className="ra-notice" role="status" key={warning}>{localizeError(warning)}</p>)}
  </div>;
}
