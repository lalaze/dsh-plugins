/**
 * Browser half: DSH's ui-workspace (vendored under ./upstream, see
 * docs/upstream.md) with workspace tags. This package's bundle patch disables
 * the stock ui-workspace, so this registration is the sidebar's only one and
 * keeps every slot the stock one declares.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyWorkspace, inject } from './upstream/index.ts'
import { TagDialogOverlay, TagMenuOverlay, type TagOverlayInjected } from './tags/overlays.tsx'
import { createTagRuntime } from './tags/runtime.ts'

export { inject }

export function apply(ctx: Context): void {
  const tagging = createTagRuntime()
  ctx.effect(() => tagging.dispose, 'workspace-tags: tag runtime')
  applyWorkspace(ctx, tagging)
  const overlayInjected = (): TagOverlayInjected => ({
    hooks: { tagMenu: tagging.menu, tagDialog: tagging.dialog, workspaceTags: tagging.tags },
    run: tagging.run,
    openMenu: tagging.openMenu,
    openDialog: tagging.openDialog,
  })
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'workspace-tags.menu', locale: 'workspace', inject: overlayInjected }, TagMenuOverlay)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'workspace-tags.dialog', locale: 'workspace', inject: overlayInjected }, TagDialogOverlay)
  })
}
