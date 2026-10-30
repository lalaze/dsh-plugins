/** Human-readable byte size (1024-based); whole bytes below 1 KiB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  // Step up when the exact value passes the unit OR the one-decimal display
  // would round to 1024.0 — the label must never read "1024.0 KB/MB/GB". At the
  // TB ceiling there is no next unit and the rounded value stands.
  while ((value >= 1024 || Number(value.toFixed(1)) >= 1024) && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(1)} ${units[i]}`
}
