import { CLAUDE_LAUNCHER, CODEX_LAUNCHER, TERMINAL_LAUNCHER } from '../../workspace/domain.js';

const LAUNCHERS = new Set<string>([TERMINAL_LAUNCHER, CLAUDE_LAUNCHER, CODEX_LAUNCHER]);
const KEY = 'remote-agents.terminal.shell.';

interface TerminalState { info?: { shell?: { path?: string; name?: string } } }
/** A DSH terminal's view. Its last three fields are internal to DSH; a version without them keeps its own behaviour. */
interface TerminalView {
  id?: string;
  shellPath?: string;
  createWhenMissing?: boolean;
  state: { getSnapshot(): TerminalState; subscribe(listener: () => void): () => void };
}
interface TerminalViews { view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): unknown }

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } };

/** The name of a launcher; on Windows its file has an extension. */
export const isRemoteLauncher = (name: string | undefined) => name !== undefined && LAUNCHERS.has(name.replace(/\.cmd$/i, ''));

/**
 * After DSH restarts, a sidebar terminal's tab says its terminal no longer exists, and DSH never replaces a terminal it
 * once listed. A remote one does still exist on its machine, so let its tab start the same launcher again: DSH reuses the
 * tab's terminal ID, and through that the launcher finds what was running (see holder-protocol.ts).
 * @returns undoes this for new views.
 */
export function restoreRemoteTerminals(terminals: TerminalViews): () => void {
  const view = terminals.view;
  if (typeof view !== 'function') return () => {};
  const wrapped: TerminalViews['view'] = function (this: TerminalViews, sessionId, key, contentId, terminalId, shellPath) {
    const model = view.call(this, sessionId, key, contentId, terminalId, shellPath) as TerminalView;
    if (!model?.id || !model.state) return model;
    const stored = KEY + model.id, shell = read(stored);
    // In time: DSH looks at this only after waiting for its list of terminals.
    if (shell && model.createWhenMissing === false) { model.createWhenMissing = true; model.shellPath = shell; }
    const remember = () => {
      const running = model.state.getSnapshot().info?.shell;
      if (running?.path && isRemoteLauncher(running.name)) write(stored, running.path);
    };
    remember();
    if (!seen.has(model)) { seen.add(model); model.state.subscribe(remember); }
    return model;
  };
  const seen = new WeakSet<object>();
  terminals.view = wrapped;
  return () => { if (terminals.view === wrapped) terminals.view = view; };
}
