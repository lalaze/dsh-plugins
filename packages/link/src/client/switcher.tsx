/** The machine switcher in the sidebar foot: which machine this page shows, and every other one to go to. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconPlayOutlineRegular, IconRefreshOutlineRegular, Menu, StateDot, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import { ui, useLocale } from './i18n.js';
import { openMachine } from './navigate.js';
import { RestartDialog } from './restart.js';
import { keepPages, shell } from './shell.js';
import { loadMachines, onScreen, SELF, useStore } from './store.js';
import { dotOf, noteOf } from './view.js';

export function MachineSwitcher({ wide = true }: { wide?: boolean }) {
  useLocale();
  const answer = useStore(state => state.answer);
  const attention = useStore(state => state.attention);
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = onScreen();
  const machines = answer?.machines ?? [];
  useEffect(() => {
    if (!open) return;
    void loadMachines();
    // About to switch: start the pages now, so they are up or nearly so by the click.
    if (keepPages()) shell()?.prefetch(machines.filter(machine => machine.state === 'online').map(machine => machine.id));
  }, [open]);

  const selfName = answer?.self.name || ui('This computer');
  const currentMachine = machines.find(machine => machine.id === current);
  const currentName = current === SELF ? selfName : currentMachine?.name ?? ui('Another machine');
  // What waits elsewhere is what the user cannot see on this page.
  const waitingElsewhere = Object.entries(attention).reduce((sum, [id, entry]) => id === current ? sum : sum + entry.waiting.length, 0);
  const finishedElsewhere = Object.entries(attention).reduce((sum, [id, entry]) => id === current ? sum : sum + entry.finished.length, 0);

  const items = useMemo<MenuEntry[]>(() => {
    // One line per machine like DSH's own menus: the name, and at the far end a short note only when the dot needs one.
    const row = (id: string, name: string, note: string) => <span className="dl-row" data-current={id === current ? '' : undefined}>
      <span className="dl-row-name">{name}</span>{note && <span className="dl-row-note">{note}</span>}
    </span>;
    return [
      { type: 'label', id: 'label', text: ui('DSH Link') },
      { id: SELF, icon: <StateDot state={dotOf(undefined, attention[SELF])} size={8} />, label: row(SELF, selfName, noteOf(undefined, attention[SELF], true)) },
      ...machines.map(machine => ({
        id: machine.id, disabled: machine.state !== 'online',
        icon: <StateDot state={dotOf(machine, attention[machine.id])} size={8} />,
        label: row(machine.id, machine.name, noteOf(machine, attention[machine.id], false)),
      })),
      ...(machines.length === 0 ? [{ id: 'none', disabled: true, label: <span className="dl-row-note">{answer ? ui('No other machine found yet') : ui('Loading…')}</span> }] : []),
    ];
  }, [answer, attention, machines, selfName, current]);
  // The actions on the machine on screen (the checked row), laid out the way DSH's own menus end: rows pinned under a
  // hairline with a 16px outline icon each (the workspace picker's 添加工作区…). DSH has no restart glyph: the refresh
  // arrow is the page, the play circle starting DSH again.
  const footer = useMemo<MenuEntry[]>(() => [
    { id: 'reload', icon: <IconRefreshOutlineRegular />, label: ui('Reload page') },
    { id: 'restart', icon: <IconPlayOutlineRegular />, label: ui('Restart DSH…') },
  ], []);

  const select = (id: string) => {
    setOpen(false);
    if (id === 'restart') setRestarting(true);
    // This page, which shows `current`: in the desktop window's frame only that machine's page loads again.
    else if (id === 'reload') location.reload();
    else if (id !== 'none') openMachine(id);
  };
  const title = waitingElsewhere ? ui('{name} · {count} waiting on other machines', { name: currentName, count: waitingElsewhere })
    : finishedElsewhere ? ui('{name} · {count} finished on other machines', { name: currentName, count: finishedElsewhere })
    : ui('{name} · switch machine', { name: currentName });

  return <>
    <button ref={trigger} type="button" className="dl-trigger" data-wide={wide ? '' : undefined} aria-haspopup="menu" aria-expanded={open} title={title} aria-label={title} onClick={() => setOpen(value => !value)}>
      <StateDot state={dotOf(currentMachine, attention[current])} size={8} />
      {wide && <span className="dl-trigger-name">{currentName}</span>}
      {waitingElsewhere > 0 ? <span className="dl-badge">{waitingElsewhere}</span>
        : finishedElsewhere > 0 && <span className="dl-badge" data-tone="done">{finishedElsewhere}</span>}
    </button>
    <Menu open={open} anchor={null} items={items} footer={footer} selectedId={current} onSelect={select} onClose={() => setOpen(false)} side="top" align="start" portal
      getAnchorRect={() => trigger.current?.getBoundingClientRect() ?? null} {...({ anchorRef: trigger } as object)} />
    <RestartDialog open={restarting} onClose={() => setRestarting(false)} name={currentName} />
  </>;
}
