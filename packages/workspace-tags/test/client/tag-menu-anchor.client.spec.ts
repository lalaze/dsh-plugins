// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { trackTagMenuAnchor } from '../../src/client/tags/menu-anchor.ts'

describe('where the tag menu opens from DSH’s context menu', () => {
  afterEach(() => { document.body.innerHTML = '' })
  const row = (id: string) => {
    const element = document.createElement('div')
    element.dataset.tagWorkspace = id
    element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 30 }) as DOMRect
    document.body.append(element)
  }

  it('opens at the pointer that chose the action', () => {
    const anchors = trackTagMenuAnchor()
    row('alpha')
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 90 }))
    expect(anchors.anchor('alpha')).toEqual({ x: 40, y: 90, width: 0, height: 0 })
    anchors.dispose()
  })

  it('opens on the Workspace’s row when chosen from the keyboard', () => {
    const anchors = trackTagMenuAnchor()
    row('alpha')
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 90 }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(anchors.anchor('alpha')).toEqual({ x: 10, y: 20, width: 200, height: 30 })
    anchors.dispose()
  })

  it('stops listening once disposed', () => {
    const anchors = trackTagMenuAnchor()
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 2 }))
    anchors.dispose()
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 90 }))
    expect(anchors.anchor('alpha')).toEqual({ x: 1, y: 2, width: 0, height: 0 })
  })
})
