// Enhance only native model groups, identified by DSH's MenuGroup and public model-label attributes.
// The native picker keeps ownership of its menus, labels, selection RPCs and additional controls.
const STORAGE_KEY = 'dsh-remote-agents:model-groups:v1';
const CHANGE_EVENT = 'dsh-remote-model-groups';
const ROW = 'button[role="menuitemradio"]';
const HEADING = '[data-menu-group-heading]';
// DSH's model list, and dsh-codex-subscription's replacement for it. That plugin registers its model
// seat without the label child slot, so its rows render bare model names with no provider id.
const MODEL_LIST = '[role="menu"][id$="-models"], [role="menu"].codexModelSelectGroups';
let memory: Record<string, boolean> = {};
/**
 * A group's folding key: the provider id its rows' model labels carry. Rows that carry no label ids
 * (DSH 0.2.0, some desktop builds, the Codex subscription menu) key the group by its heading, but only
 * inside a model list.
 */
function providerKey(element: HTMLElement, heading: HTMLElement, rows: readonly HTMLButtonElement[]): string | undefined {
  const ids = new Set(rows.map(row => row.querySelector<HTMLElement>('[data-provider-id][data-model-id]')?.dataset.providerId));
  if (ids.size !== 1) return undefined;
  const [id] = ids;
  if (id) return id;
  const name = heading.textContent?.trim();
  return name && element.parentElement?.matches(MODEL_LIST) ? `name:${name}` : undefined;
}
function readGroups(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) memory = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'));
  } catch { /* Use in-memory preferences when storage is unavailable. */ }
  return memory;
}
const styles = `
[data-ra-model-hidden]{display:none!important}
[data-ra-model-provider]>[data-menu-group-heading]{display:flex;align-items:center;gap:7px;cursor:pointer;outline-offset:-2px}
[data-ra-model-provider]>[data-menu-group-heading]:before{content:'›';display:inline-block;font-size:16px;line-height:12px;transform:rotate(0deg)}
[data-ra-model-provider]>[aria-expanded=true]:before{transform:rotate(90deg)}
[data-ra-model-provider]>[data-menu-group-heading]:after{content:attr(data-ra-model-count);margin-left:auto;font-size:11px;opacity:.65;font-variant-numeric:tabular-nums}
[data-ra-model-provider]>[data-menu-group-heading]:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#517ee8)}
[data-ra-model-provider]>[aria-disabled=true]{cursor:default}
[data-ra-model-provider] button[data-ra-model-option]{background:transparent}
[data-ra-model-provider] button[data-ra-model-active]:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}
`;
interface Group { element: HTMLElement; heading: HTMLElement; provider: string; rows: HTMLButtonElement[]; restore: () => void }
interface Menu { element: HTMLElement; groups: Map<HTMLElement, Group>; active?: HTMLButtonElement; query: string; dispose: () => void }
function setAttribute(element: Element, name: string, value: string | null) {
  if (value === null) { if (element.hasAttribute(name)) element.removeAttribute(name); }
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** Bounded DOM enhancement: no slot shadowing, React tree edits, or host state writes. */
export function installModelGroups(): () => void {
  if (typeof document === 'undefined') return () => {};
  const menus = new Map<HTMLElement, Menu>();
  const style = document.createElement('style'); style.dataset.remoteModelGroups = ''; style.textContent = styles;
  document.head.append(style);
  let stopped = false, scheduled = false;
  const visibleRows = (menu: Menu) => [...menu.groups.values()].flatMap(group => group.rows.filter(row => !row.hasAttribute('data-ra-model-hidden') && !row.disabled));
  const highlight = (menu: Menu, row?: HTMLButtonElement) => {
    menu.active = row;
    for (const group of menu.groups.values()) for (const option of group.rows) setAttribute(option, 'data-ra-model-active', option === row ? '' : null);
  };
  const refreshMenu = (menu: Menu) => {
    const query = menu.element.querySelector('input')?.value.trim() ?? '';
    if (query !== menu.query) { menu.query = query; menu.active = undefined; }
    const preferences = readGroups();
    for (const group of menu.groups.values()) {
      const selected = group.rows.some(row => row.getAttribute('aria-checked') === 'true');
      const collapsed = !query && (preferences[group.provider] ?? !selected);
      const busy = group.rows.every(row => row.disabled);
      setAttribute(group.heading, 'aria-expanded', String(!collapsed));
      setAttribute(group.heading, 'aria-disabled', String(!!query || busy));
      setAttribute(group.heading, 'data-ra-model-count', String(group.rows.length));
      for (const row of group.rows) {
        setAttribute(row, 'data-ra-model-option', '');
        setAttribute(row, 'data-ra-model-hidden', collapsed ? '' : null);
      }
    }
    const rows = visibleRows(menu);
    highlight(menu, rows.includes(menu.active!) ? menu.active : rows.find(row => row.hasAttribute('data-highlighted')) ?? rows.find(row => row.getAttribute('aria-checked') === 'true') ?? rows[0]);
  };
  const toggle = (menu: Menu, group: Group, collapsed = group.heading.getAttribute('aria-expanded') === 'true') => {
    if (group.heading.getAttribute('aria-disabled') === 'true') return;
    memory = { ...readGroups(), [group.provider]: collapsed };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch {}
    refreshMenu(menu);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  const attachMenu = (element: HTMLElement): Menu => {
    const menu: Menu = { element, groups: new Map(), query: '', dispose: () => {} };
    const headingGroup = (target: EventTarget | null) => target instanceof Element ? [...menu.groups.values()].find(group => group.heading.contains(target)) : undefined;
    const click = (event: MouseEvent) => {
      const group = headingGroup(event.target); if (!group) return;
      event.preventDefault(); event.stopImmediatePropagation(); toggle(menu, group); group.heading.focus();
    };
    const move = (event: MouseEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(ROW) : null;
      if (row && visibleRows(menu).includes(row)) highlight(menu, row);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || !menu.groups.size) return;
      const group = headingGroup(event.target), input = event.target instanceof HTMLInputElement;
      const rows = visibleRows(menu), allRows = [...menu.groups.values()].flatMap(g => [g.heading, ...g.rows.filter(row => rows.includes(row))]);
      const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (group && ['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        consume(); toggle(menu, group, event.key === 'ArrowLeft' ? true : event.key === 'ArrowRight' ? false : undefined); return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (input || allRows.includes(event.target as HTMLElement))) {
        if (input && (event.key === 'Home' || event.key === 'End')) return;
        consume();
        const options = input && rows.length ? rows : allRows;
        if (!options.length) return;
        const active = input && rows.length ? menu.active : document.activeElement;
        const index = options.indexOf(active as HTMLButtonElement), direction = event.key === 'ArrowUp' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? direction > 0 ? 0 : options.length - 1 : (index + direction + options.length) % options.length;
        const option = options[next];
        if (option instanceof HTMLButtonElement) highlight(menu, option);
        if (!input || !rows.length) option.focus();
        option.scrollIntoView({ block: 'nearest' }); return;
      }
      if (input && (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey)) {
        consume();
        if (menu.active && rows.includes(menu.active)) menu.active.click();
        else if (event.key === 'Tab') allRows[0]?.focus();
      }
    };
    element.addEventListener('click', click, true); element.addEventListener('mousemove', move, true); element.addEventListener('keydown', key, true);
    menu.dispose = () => {
      element.removeEventListener('click', click, true); element.removeEventListener('mousemove', move, true); element.removeEventListener('keydown', key, true);
      for (const group of menu.groups.values()) group.restore(); menus.delete(element);
    };
    menus.set(element, menu); return menu;
  };
  const scan = () => {
    scheduled = false; if (stopped) return;
    const found = new Set<HTMLElement>();
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-menu-material] [data-menu-group]'))) {
      const heading = element.querySelector<HTMLElement>(`:scope > ${HEADING}`), rows = Array.from(element.querySelectorAll<HTMLButtonElement>(`:scope > ${ROW}`));
      const provider = heading && providerKey(element, heading, rows);
      // Leave unrelated menus and unknown future markup untouched.
      if (!heading || !provider) continue;
      const surface = element.closest<HTMLElement>('[data-menu-material]'); if (!surface) continue;
      const menu = menus.get(surface) ?? attachMenu(surface); found.add(element);
      let group = menu.groups.get(element);
      if (group && (group.heading !== heading || group.provider !== provider)) { group.restore(); menu.groups.delete(element); group = undefined; }
      if (!group) {
        const attributes = ['role', 'tabindex', 'aria-expanded', 'aria-disabled', 'data-ra-model-count'].map(name => [name, heading.getAttribute(name)] as const);
        group = { element, heading, provider, rows, restore: () => {
          for (const [name, value] of attributes) setAttribute(heading, name, value);
          element.removeAttribute('data-ra-model-provider');
          for (const row of group!.rows) for (const attr of ['data-ra-model-hidden', 'data-ra-model-option', 'data-ra-model-active']) row.removeAttribute(attr);
        } };
        menu.groups.set(element, group);
        element.dataset.raModelProvider = provider; heading.setAttribute('role', 'button'); heading.tabIndex = 0;
      }
      group.rows = rows;
    }
    for (const menu of menus.values()) {
      for (const [element, group] of menu.groups) if (!found.has(element)) { group.restore(); menu.groups.delete(element); }
      if (!menu.element.isConnected) menu.dispose(); else refreshMenu(menu);
    }
  };
  const schedule = () => { if (!scheduled && !stopped) { scheduled = true; queueMicrotask(scan); } };
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) schedule(); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'data-highlighted'] });
  document.addEventListener('input', schedule, true); window.addEventListener('storage', storage); window.addEventListener(CHANGE_EVENT, schedule);
  scan();
  return () => {
    stopped = true; observer.disconnect(); document.removeEventListener('input', schedule, true); window.removeEventListener('storage', storage); window.removeEventListener(CHANGE_EVENT, schedule);
    for (const menu of menus.values()) menu.dispose(); style.remove();
  };
}
