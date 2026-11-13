/** The part of DSH's conversation list this follows. */
export interface ListedSessions { getSnapshot(): { byId?: Record<string, unknown> } | undefined; subscribe(listener: () => void): () => void }

/**
 * A TUI conversation another DSH started arrives as a conversation the plugin's server makes, and DSH lists it like any
 * other: the page learns that it is a TUI conversation only by asking. So a conversation appearing in the list that the
 * page does not know as one makes it ask again, a few times, as the server records it a moment after DSH lists it.
 * The conversations listed when the page loads are covered by its first request.
 * @param known - whether a conversation is a TUI conversation as far as the page knows.
 * @param refresh - asks the server for the TUI conversations.
 * @returns stops following.
 */
export function followNewSessions(list: ListedSessions, known: (id: string) => boolean, refresh: () => void, delays: readonly number[] = [1000, 4000, 10_000]): () => void {
  let seen: Set<string> | undefined, timers: ReturnType<typeof setTimeout>[] = [];
  const check = () => {
    const byId = list.getSnapshot()?.byId;
    if (!byId) return;
    const ids = Object.keys(byId);
    if (!seen) { seen = new Set(ids); return; }
    let found = false;
    for (const id of ids) if (!seen.has(id)) { seen.add(id); if (!known(id)) found = true; }
    if (!found) return;
    for (const timer of timers) clearTimeout(timer);
    timers = delays.map(delay => setTimeout(refresh, delay));
  };
  check();
  const off = list.subscribe(check);
  return () => { off(); for (const timer of timers) clearTimeout(timer); };
}
