/**
 * DSH's New terminal opens one browser-remembered shell in every conversation (dsh-api-terminal-controller's
 * `dsh.terminal.shell`). While a remote conversation is in view it is the Remote workspace launcher; leaving gives
 * back the shell remembered before, unless another shell was chosen meanwhile.
 */
const DSH_KEY = 'dsh.terminal.shell', SAVED_KEY = 'remote-agents.terminal.previousShell';
type Saved = { remote: string; previous: string | null };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
};
const saved = (): Saved | undefined => {
  try {
    const value: unknown = JSON.parse(read(SAVED_KEY) ?? 'null');
    if (value && typeof value === 'object' && typeof (value as Saved).remote === 'string') {
      const previous = (value as Saved).previous;
      return { remote: (value as Saved).remote, previous: typeof previous === 'string' ? previous : null };
    }
  } catch { /* a damaged record only loses the restore */ }
  return undefined;
};

/** @param remoteShell - the Remote workspace launcher while a remote conversation is in view, otherwise undefined. */
export function preferTerminalShell(remoteShell: string | undefined): void {
  const current = read(DSH_KEY), record = saved();
  if (remoteShell) {
    if (current === remoteShell) return;
    // Remember the user's own shell once, not a launcher path from an earlier install.
    write(SAVED_KEY, JSON.stringify({ remote: remoteShell, previous: record && current === record.remote ? record.previous : current }));
    write(DSH_KEY, remoteShell);
    return;
  }
  if (!record) return;
  if (current === record.remote) write(DSH_KEY, record.previous);
  write(SAVED_KEY, null);
}
