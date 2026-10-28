import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { DebuggerBridge, createHandler } from './bridge.js';
export const name = 'dsh-browser-devtools';
export const inject = ['connection'];
export function apply(ctx: Context): void {
  const bridge = new DebuggerBridge();
  ctx.effect(() => () => bridge.dispose());
  ctx.connection.fetch.register({ path: '/api/browser-devtools', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(bridge) });
}
