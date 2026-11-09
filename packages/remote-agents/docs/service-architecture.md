# Remote agent service internals

`RemoteAgentsService` is the compatibility facade used by the plugin, chat adapters,
workspace services, tools and HTTP handlers. Its public methods, return values and
three shared listener Sets remain unchanged. The persistent Store schema is unchanged.

## Ownership and dependencies

- `HostConnections` owns the backend map, readiness promises, machine identity checks,
  host status, error redaction, host creation and model catalog discovery/selection.
  It receives the Store, a backend factory, the facade's serial execution function,
  and a backend-created callback. It does not import or receive the service.
- `SharedSync` owns shared-history/workspace/read notification wiring, conversation read
  marks, sender attribution and shared workspace/tag operations. It receives the Store,
  only the host module's `host`, `backend`, `peek` and `stopped` capabilities, and three
  notification callbacks. It cannot run catalog mutations or verified remote actions.
- The facade owns task mutations, summaries, restore deduplication, delegation retry
  windows, and the cross-cutting workflows for host removal and sharing changes.
  It composes both modules. Neither module calls back into task lifecycle methods.

The default backend factory still closes over `() => this.sharing`: plugin startup
assigns its launch-sharing integration after constructing the service. Backend creation
is lazy. The created callback subscribes shared notifications immediately, before any
connection, and dispatch callbacks read the facade's current listener Sets. Read events
look up the task's current conversation binding when the event arrives. Backend shutdown
retains responsibility for stopping its event sources, as before this extraction.

## Access and failure boundaries

`peek` observes an existing backend without constructing one and is safe after close.
Host summaries, shared read marks and sender attribution use this path. Task summaries
may also perform their existing local `agent` read; that read can construct a backend,
but never probes SSH or restores a relay. `backend` supplies that local backend access
for history, process control and explicit recovery. It refuses new access once stopped.

`use` is the verified remote-operation path. Initial connection readiness is shared,
and each operation rechecks the machine identity. Connection or identity failures mark
the host as failed and clear readiness for a later retry. Expected task-server mismatch,
workspace verification and action failures preserve connection status. Both error paths
redact saved passwords, cap error text and preserve `RemoteError` status codes.

Discovery keeps the previous catalog when a probe fails. Every discovery branch notifies
once; provider selection notifies once for the saved selection and once for discovery.
Disabling every CLI avoids connecting. Removal notifies once after successfully closing
the removed backend. Existing notification exception behavior is unchanged.

## Serialization, replacement and shutdown

There is one lock map, owned by the facade. Catalog discovery/selection, host removal and
sharing changes use `catalog:${hostId}` through that same queue; task mutations and
restores use task IDs. Summaries consult the task lock to distinguish an in-flight start
from an interrupted record. A rejected operation does not poison the next queued one.

Removal first deletes or forgets tasks under their task locks, without reconnecting an
offline host. It then atomically clears the host, project bindings, queued relay cleanup,
shared deletions and seen workspaces. A concurrently created task still prevents removal.
Sharing changes withdraw locally owned sessions and forget imported copies before saving
the setting. Backend replacement removes the old map entry before awaiting its close;
only a successful close triggers the facade's background resume. Failures preserve the
same partial-progress semantics as before.

Service close has two host-module phases, deliberately separated by the facade's drain:

1. `closeBackends()` marks stopped synchronously and closes all existing backends with
   `allSettled`. Closing releases persistent work; it does not stop or detach it.
2. The facade waits for every pending lock, including catalog work and task receipts.
   Closing backends first unblocks pending CLI starts; reversing these steps can deadlock.
3. The facade clears connections and delegation recovery state, then flushes the Store.

Recovery remains opt-in: opening a conversation restores only its saved relays; viewing
archived history does not attach it. Delegation polls retain the 30-second retry window,
with a fresh attempt when the relay ID changes. Sharing still starts on readiness,
resume, conversation resume, marking read and shared workspace listing.

`test/service-boundaries.test.ts` exercises these module/facade boundaries with fake
remote I/O and deterministic barriers, without sockets. Existing service, backend,
sharing and relay tests continue to exercise the unchanged public facade.
