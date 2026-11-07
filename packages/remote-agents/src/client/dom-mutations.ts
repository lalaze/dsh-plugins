/**
 * Whether a DOM batch can change an enhancement's elements. Terminal output and chat text can mutate many times per
 * frame: observing the document must not mean querying the whole document for each such batch. Only inspect the
 * changed subtrees and the target's ancestors. Removed elements matter too (including cleanup of tracked nodes).
 */
export function affectsElements(records: readonly MutationRecord[], selector: string): boolean {
  const contains = (node: Node) => {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return element.matches(selector) || element.querySelector(selector) !== null;
  };
  return records.some(record => {
    const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
    if (target?.closest(selector)) return true;
    if (record.type !== 'childList') return false;
    return Array.from(record.addedNodes).some(contains) || Array.from(record.removedNodes).some(contains);
  });
}
