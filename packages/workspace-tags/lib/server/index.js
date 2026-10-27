import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from './server/store.js';
import { TagError, TAGS_ROUTE } from './shared/tags.js';
export const name = 'dsh-workspace-tags';
export const inject = ['connection'];
const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(defaultStateDir()) });
export async function apply(ctx, config = {}) {
    const store = new TagStore(join(config.stateDir ?? defaultStateDir(), 'tags.json'));
    await store.load();
    const headers = { 'Cache-Control': 'no-store' };
    // The host connection supplies authentication and origin checks.
    ctx.effect(() => ctx.connection.fetch.register({
        path: TAGS_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: request => handleTagRequest(store, request, headers),
    }));
}
export async function handleTagRequest(store, request, headers = {}) {
    if (request.method === 'GET')
        return Response.json({ state: store.snapshot() }, { headers });
    let operation;
    try {
        operation = await request.json();
    }
    catch {
        return Response.json({ error: 'Invalid request' }, { status: 400, headers });
    }
    try {
        const { state, tag } = await store.apply(operation);
        return Response.json({ state, ...(tag ? { tag } : {}) }, { headers });
    }
    catch (error) {
        if (error instanceof TagError)
            return Response.json({ error: error.message }, { status: 400, headers });
        console.warn('[dsh-workspace-tags] Could not save tags', error);
        return Response.json({ error: 'Could not save tags' }, { status: 500, headers });
    }
}
