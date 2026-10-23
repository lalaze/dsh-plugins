import { installDevTools } from './install.js';

export const name = 'dsh-browser-devtools-client';
export function apply(ctx: { effect(factory: () => () => void): void }): void {
  ctx.effect(() => installDevTools(document));
}
