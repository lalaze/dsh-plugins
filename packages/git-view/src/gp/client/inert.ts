/**
 * React 18 types predate the `inert` attribute; the DOM takes a valueless one.
 * `inert` removes a subtree from the accessibility tree and from the tab order,
 * which is what makes a `aria-modal` claim true.
 *
 * @param on Whether the element should be inert.
 * @returns Props to spread, empty when the element stays interactive.
 */
export function inertAttr(on: boolean): Record<string, string> {
  return on ? { inert: '' } : {}
}
