import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { RemoteAgentsService } from './service.js';
import { createHandler } from './http.js';
import { ClaudeConfig, claudeInject, installNativeClaude } from './native-claude.js';

export const name = 'dsh-remote-agents';
export const inject = ['connection', ...claudeInject];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()), claude: ClaudeConfig });
export async function apply(ctx: Context, config: { stateDir?: string; claude?: Record<string, unknown> } = {}): Promise<void> {
  const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
  installNativeClaude(ctx, config.claude);
  const service = new RemoteAgentsService(store);
  ctx.effect(() => () => service.close());
  ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service) });
}
