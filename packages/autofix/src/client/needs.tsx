import React, { useSyncExternalStore } from 'react';
import { remoteFrom } from '@dsh-plugins/needs';
import { usePluginOffer } from '@dsh-plugins/needs/react';
import { ui } from './i18n.js';

/** The plugin's own client context: what DSH and other plugins' clients offer is read from it when it is used. */
interface Host { get?(name: string): unknown }
let host: Host | undefined;
export function setHost(next: Host): () => void {
  host = next;
  return () => { if (host === next) host = undefined; };
}
export function service<T>(name: string): T | undefined {
  try { return host?.get?.(name) as T | undefined; } catch { return undefined; }
}

/** A source's own settings, drawn inside this page: what the client of the source's plugin registered. */
export interface SourcePanel {
  name: string; Panel: React.ComponentType<{ embedded: true }>;
  /** The source's own messages in the page's language; this plugin's dictionary does not have them. */
  text?(key: string, values?: Record<string, string>): string;
}
const panels = new Map<string, SourcePanel>(), watchers = new Set<() => void>();
let snapshot: ReadonlyMap<string, SourcePanel> = new Map();
const changed = () => { snapshot = new Map(panels); for (const watcher of watchers) watcher(); };
/** The client service `autofixSources`: a source's plugin puts its settings into this page instead of a page of its own. */
export const sourcePanels = {
  version: 1,
  register(id: string, panel: SourcePanel): () => void {
    panels.set(id, panel); changed();
    return () => { if (panels.get(id) === panel) { panels.delete(id); changed(); } };
  },
};
/** A source's message in the page's language: its plugin's words when that plugin gave its translator, this plugin's otherwise. */
export const sourceText = (id: string, message: { key: string; values?: Record<string, string> }): string =>
  panels.get(id)?.text?.(message.key, message.values) ?? ui(message.key, message.values);
const watch = (listener: () => void) => { watchers.add(listener); return () => { watchers.delete(listener); }; };
export const useSourcePanels = (): ReadonlyMap<string, SourcePanel> => useSyncExternalStore(watch, () => snapshot, () => snapshot);

/**
 * A plugin this page works through and DSH does not run: what it is for, and the way to get it. `optional` is one the
 * page can do without. `leave` closes the settings, which cover the Plugins page.
 */
export function Need({ plugin, title, why, optional, leave, settled }: { plugin: string; title: string; why: string; optional?: boolean; leave(): void; settled(): void }) {
  const { offer, busy, outcome, run } = usePluginOffer(() => remoteFrom(host), plugin, settled);
  const plugins = service<{ openBundle(name: string): void; openList(): void }>('pluginNavigation');
  const installable = offer?.kind === 'install' || offer?.kind === 'update';
  const done = outcome?.kind === 'applied' || outcome?.kind === 'restart';
  const says = outcome?.kind === 'restart' ? ui("Installed. It starts the next time DSH starts.")
    : outcome?.kind === 'applied' ? ui("Installed.")
    : outcome?.kind === 'failed' ? ui("It could not be installed: {0}", { 0: outcome.detail })
    : busy ? ui("Installing… this can take a minute.")
    : !offer ? ui("Looking in your plugin markets…")
    : offer.kind === 'present' ? ui("It is installed but not running: switch it on in Plugins, or restart DSH.")
    : offer.kind === 'update' ? ui("Version {0} is installed; this needs {1}.", { 0: offer.installed ?? '?', 1: offer.version })
    : !installable ? ui("None of your plugin markets offers it: add it on the Plugins page.") : undefined;
  const open = () => { if (offer?.kind === 'present') plugins?.openBundle(plugin); else plugins?.openList(); leave(); };
  return <div className="tp-need" data-optional={optional || undefined}>
    <div className="tp-need-text">
      <span>{optional ? title : ui("Needs the plugin {0}", { 0: title })}<code>{plugin}</code></span>
      <small>{why}</small>
      {says && <small className={outcome?.kind === 'failed' ? 'tp-error' : undefined} role={outcome?.kind === 'failed' ? 'alert' : 'status'}>{says}</small>}
    </div>
    {installable && !done && <button type="button" className="tp-button" data-primary={!optional || undefined} disabled={busy} onClick={run}>
      {busy ? ui("Installing…") : offer.kind === 'update' ? ui("Update") : ui("Install")}</button>}
    {plugins && offer && (!installable || outcome?.kind === 'failed') && <button type="button" className="tp-button" onClick={open}>{ui("Open Plugins")}</button>}
  </div>;
}
