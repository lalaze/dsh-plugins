import type { LocaleContext } from '@dsh-plugins/i18n'
import type React from 'react'
import { installLocale, ui } from './i18n.js'
import { SyncSettings } from './settings.js'

interface Client extends LocaleContext {
  effect(factory: () => () => void): void
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown }
}

export const name = 'dsh-device-sync-client'
// The desktop language bridge initializes asynchronously; wait before registering UI.
export const inject = ['slots', 'locale']
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'device-sync', order: 75, label: () => ui('Device sync') }, SyncSettings))
}
