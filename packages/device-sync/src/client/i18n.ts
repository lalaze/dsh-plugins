import { createI18n } from '@dsh-plugins/i18n'
import { useLocale as useI18n } from '@dsh-plugins/i18n/react'
import { zh } from './locales.js'

export const i18n = createI18n('dsh-device-sync', zh)
export const { ui, installLocale, activeLocale, formatLocale, localizeError } = i18n
export const useLocale = () => useI18n(i18n)

/** "3 minutes ago"-style time in the active language. */
export function ago(time: number | undefined): string {
  if (!time) return ui('Never')
  const seconds = Math.round((Date.now() - time) / 1000)
  if (seconds < 5) return ui('Just now')
  const format = new Intl.RelativeTimeFormat(formatLocale(), { numeric: 'auto' })
  if (seconds < 60) return format.format(-seconds, 'second')
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return format.format(-Math.round(seconds / 3600), 'hour')
  return format.format(-Math.round(seconds / 86_400), 'day')
}
