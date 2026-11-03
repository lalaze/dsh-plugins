/**
 * Host half of dsh-mobile. It connects this machine to a relay, so paired phones can read and steer its sessions
 * from anywhere, and serves the desktop settings page and a copy of the phone app through DSH's own connection.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ROUTE, LOCAL_ROUTE, type LocalAction } from './shared/protocol.js'
import { CommandError } from './server/bridge/executor.js'
import { dshHost } from './server/bridge/host.js'
import { Hub, HttpError, type WorkspaceTagsService } from './server/hub.js'

export const name = 'dsh-mobile'
export const inject = ['connection']

const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name)
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

export interface Config {
  stateDir?: string
  relay?: string
  appUrl?: string
}
export const Config = Schema.object({
  stateDir: Schema.string().default(defaultStateDir()),
  relay: Schema.string().description('Relay for a new setup, such as relay.example.com:443. Change it later under Settings → Phone access.'),
  appUrl: Schema.string().description('Address of the phone app for a new setup. Change it later under Settings → Phone access.'),
})

const headers = { 'Cache-Control': 'no-store' }
const failure = (error: unknown) => {
  const status = error instanceof HttpError || error instanceof CommandError ? error.status : 500
  if (status === 500) console.warn('[dsh-mobile] Request failed', error)
  return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status, headers })
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const log = (message: string) => (ctx.get('logger') as { warn?(m: string): void } | undefined)?.warn?.(message) ?? console.warn(`[dsh-mobile] ${message}`)
  const version = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version as string
  const hub = await Hub.open({ stateDir: config.stateDir ?? defaultStateDir(), host: dshHost(ctx), tags: () => ctx.get('workspaceTags') as WorkspaceTagsService | undefined, tasks: () => ctx.get('remoteAgentsTasks'), version, defaults: { relay: config.relay, appUrl: config.appUrl }, log })
  await hub.start()
  ctx.effect(() => () => { void hub.close() })
  // The host connection authenticates these routes; only the owner's browsers reach them.
  ctx.effect(() => ctx.connection.fetch.register({ path: LOCAL_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => handleLocal(hub, request) }))
  // The app copy is optional: a route DSH refuses must not take the plugin down with it.
  for (const route of await appRoutes()) {
    try { ctx.effect(() => ctx.connection.fetch.register({ path: route.path, methods: ['GET'], requestBody: 'buffered', fetch: () => route.respond() })) }
    catch (error) { log(`Could not serve ${route.path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

export async function handleLocal(hub: Hub, request: Request): Promise<Response> {
  try {
    if (request.method === 'GET') return Response.json(hub.status(), { headers })
    // A page on another origin cannot set this header without a preflight the host refuses.
    if (request.headers.get('X-DSH-Mobile') !== '1') throw new HttpError('Use the phone access settings to send requests', 403)
    let input: LocalAction
    try { input = await request.json() as LocalAction } catch { throw new HttpError('Invalid request') }
    return Response.json(await hub.action(input) ?? { ok: true }, { headers })
  } catch (error) { return failure(error) }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
}

/**
 * DSH's rule for an exact route: `/api` followed by segments of letters, digits and `_$.-`, none empty. A path it
 * refuses makes route registration throw, which unloads the whole plugin.
 */
export const isRoutePath = (path: string) => /^\/api(\/[A-Za-z0-9_$.-]+)+$/.test(path) && !path.split('/').some(segment => segment === '.' || segment === '..')

/** The phone app's files DSH can serve: one exact route each, since DSH routes do not match prefixes. */
export const appFiles = (files: string[]) => files.filter(file => Object.hasOwn(TYPES, extname(file)) && isRoutePath(`${APP_ROUTE}/${file}`))

async function appRoutes(): Promise<{ path: string; respond(): Promise<Response> }[]> {
  const dir = join(packageRoot, 'lib', 'app')
  let files: string[]
  try { files = appFiles(await readdir(dir)) } catch { return [] }
  const serve = (file: string) => async () => new Response(new Uint8Array(await readFile(join(dir, file))), { headers: {
    'Content-Type': TYPES[extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    ...(file === 'sw.js' ? { 'Service-Worker-Allowed': `${APP_ROUTE}/` } : {}),
  } })
  return files.map(file => ({ path: `${APP_ROUTE}/${file}`, respond: serve(file) }))
}
