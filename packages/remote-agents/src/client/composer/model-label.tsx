import React from 'react';

const remote = (provider: string) => provider === 'remote-cli' || provider.startsWith('remote-cli-');
export interface ModelLabelProps { provider: { id: string }; model: { name: string }; placement: 'trigger' | 'menu' | 'option' }

/** Catalog names are `<model> · <host>`; split at the last separator so model labels may contain one. */
export function splitHost(name: string): { model: string; host?: string } {
  const at = name.lastIndexOf(' · ');
  return at > 0 ? { model: name.slice(0, at), host: name.slice(at + 3) } : { model: name };
}

/**
 * The picker only lists the workspace machine's models, so the composer caption drops the host.
 * Rows keep it muted to tell apart saved hosts that reach the same machine; the native tooltip keeps the full name.
 */
export function ModelLabel({ provider, model, placement }: ModelLabelProps) {
  const { model: label, host } = remote(provider.id) ? splitHost(model.name) : { model: model.name };
  if (!host || placement !== 'option') return <>{label}</>;
  return <>{label}<span data-ra-model-host="" style={{ marginLeft: '.5em', opacity: .6 }}>{host}</span></>;
}
