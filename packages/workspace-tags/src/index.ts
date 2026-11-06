/**
 * Host half: stores workspace tags in the DSH home, so every client of this
 * host (desktop or remote web) sees the same tags. The sidebar itself is the
 * client half, a fork of DSH's ui-workspace that this package's bundle patch
 * swaps in for the stock one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TagStore } from './server/store.js'
import { TagError, TAGS_ROUTE, type TagOperation, type TagState } from './shared/tags.js'

/**
 * What other host plugins may do with the tags, as the service `workspaceTags`.
 */
export interface WorkspaceTagsService {
  readonly version: 1
  snapshot(): TagState
  /** Save a merged state; invalid entries are dropped and the user's tag order stays on. Open sidebars pick it up on their next refresh. */
  replace(state: TagState): Promise<TagState>
  /** Called after each saved change, including those made through {@link replace}. */
  subscribe(listener: (state: TagState) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { workspaceTags: WorkspaceTagsService }
}

export const name = 'dsh-workspace-tags'
export const inject = ['connection']

const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name)
export const Config = Schema.object({ stateDir: Schema.string().default(defaultStateDir()) })

export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new TagStore(join(config.stateDir ?? defaultStateDir(), 'tags.json'))
  await store.load()
  const headers = { 'Cache-Control': 'no-store' }
  ctx.provide('workspaceTags', {
    version: 1,
    snapshot: () => store.snapshot(),
    replace: async state => (await store.replace(state)).state,
    subscribe: listener => store.subscribe(listener),
  } satisfies WorkspaceTagsService)
  // The host connection supplies authentication and origin checks.
  ctx.effect(() => ctx.connection.fetch.register({
    path: TAGS_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => handleTagRequest(store, request, headers),
  }))
}

export async function handleTagRequest(store: TagStore, request: Request, headers: Record<string, string> = {}): Promise<Response> {
  if (request.method === 'GET') {
    // A client that already holds this revision gets an empty answer, which keeps frequent refreshes cheap.
    const revision = store.revision()
    if (new URL(request.url).searchParams.get('revision') === revision) return new Response(null, { status: 204, headers })
    return Response.json({ state: store.snapshot(), revision }, { headers })
  }
  let operation: TagOperation
  try { operation = await request.json() as TagOperation }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers }) }
  try {
    const { state, tag } = await store.apply(operation)
    return Response.json({ state, revision: store.revision(), ...(tag ? { tag } : {}) }, { headers })
  } catch (error) {
    if (error instanceof TagError) return Response.json({ error: error.message }, { status: 400, headers })
    console.warn('[dsh-workspace-tags] Could not save tags', error)
    return Response.json({ error: 'Could not save tags' }, { status: 500, headers })
  }
}
