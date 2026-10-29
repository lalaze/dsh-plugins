import { installModelGroups } from './model-groups.js';

export const name = 'dsh-model-groups-client';
export function apply(ctx: { effect(factory: () => () => void): void }): void {
  ctx.effect(installModelGroups);
}
