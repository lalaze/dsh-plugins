import type { TagMenuAnchor } from './contract.ts'

/**
 * Where the tag menu opens when "Tags…" is chosen in DSH's context menu, whose actions do not say where they were
 * chosen: at the pointer that clicked it, or from the keyboard, on the Workspace's row.
 */
export function trackTagMenuAnchor(): { anchor(workspaceId: string): TagMenuAnchor; dispose(): void } {
  let pointer: { x: number; y: number } | undefined
  const onPointer = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY } }
  const onKey = () => { pointer = undefined }
  window.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('keydown', onKey, true)
  return {
    anchor(workspaceId) {
      if (pointer !== undefined) return { ...pointer, width: 0, height: 0 }
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-tag-workspace]')).find(element => element.dataset.tagWorkspace === workspaceId)?.getBoundingClientRect()
      return row === undefined ? { x: 0, y: 0, width: 0, height: 0 } : { x: row.left, y: row.top, width: row.width, height: row.height }
    },
    dispose() {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    },
  }
}
