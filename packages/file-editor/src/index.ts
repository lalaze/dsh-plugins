import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { editorHandler } from './editor-route.js';
import { LocalFiles } from './files.js';
import { createHandler } from './http.js';

export const name = 'dsh-file-editor';
export const inject = ['connection'];

/** A conversation's working directory, from the live session or, before it is opened, from saved sessions. */
async function sessionCwd(ctx: Context, sessionId: string): Promise<string | undefined> {
  const sessions = ctx.get('sessions') as { get?(id: string): { header: { cwd?: string } } | undefined } | undefined;
  const live = sessions?.get?.(sessionId);
  if (live) return live.header.cwd;
  const persistence = ctx.get('sessionPersistence') as { list(): Promise<({ id: string; cwd?: string } | { header: { id: string; cwd?: string } })[]> } | undefined;
  const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
  // A session activated meanwhile is the authority.
  return sessions?.get?.(sessionId)?.header.cwd ?? stored?.cwd;
}

export function apply(ctx: Context): void {
  const files = new LocalFiles(id => sessionCwd(ctx, id));
  const log = (message: string) => (ctx.get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message);
  ctx.connection.fetch.register({ path: '/api/file-editor', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(files, log) });
  // The client's EDITOR_SRC; the build writes the bundle next to lib/server.
  ctx.connection.fetch.register({ path: '/api/file-editor/editor.js', methods: ['GET'], requestBody: 'buffered', fetch: editorHandler(new URL('../editor.js', import.meta.url)) });
}
