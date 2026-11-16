/** The machine switcher in the sidebar foot: which machine this page shows, and every other one to go to. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, StateDot, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import { ui, useLocale } from './i18n.js';
import { openMachine } from './navigate.js';
import { RestartDialog } from './restart.js';
import { loadMachines, onScreen, SELF, useStore } from './store.js';
import { dotOf, summaryOf } from './view.js';

export function MachineSwitcher({ wide = true }: { wide?: boolean }) {
  useLocale();
  const answer = useStore(state => state.answer);
  const attention = useStore(state => state.attention);
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = onScreen();
  useEffect(() => { if (open) void loadMachines(); }, [open]);

  const machines = answer?.machines ?? [];
  const selfName = answer?.self.name || ui('This computer');
  const currentMachine = machines.find(machine => machine.id === current);
  const currentName = current === SELF ? selfName : currentMachine?.name ?? ui('Another machine');
  // What waits elsewhere is what the user cannot see on this page.
  const waitingElsewhere = Object.entries(attention).reduce((sum, [id, entry]) => id === current ? sum : sum + entry.waiting.length, 0);

  const items = useMemo<MenuEntry[]>(() => {
    const row = (name: string, meta: string) => <span className="dm-row"><span className="dm-row-name">{name}</span><span className="dm-row-meta">{meta}</span></span>;
    return [
      { type: 'label', id: 'label', text: ui('Machines') },
      { id: SELF, icon: <StateDot state={dotOf(undefined, attention[SELF])} size={8} />, label: row(selfName, summaryOf(undefined, attention[SELF], true)) },
      ...machines.map(machine => ({
        id: machine.id, disabled: machine.state !== 'online',
        icon: <StateDot state={dotOf(machine, attention[machine.id])} size={8} />,
        label: row(machine.name, summaryOf(machine, attention[machine.id], false)),
      })),
      ...(machines.length === 0 ? [{ id: 'none', disabled: true, label: <span className="dm-row-meta">{answer ? ui('No other machine found yet') : ui('Loading…')}</span> }] : []),
      { type: 'separator', id: 'separator' },
      { id: 'restart', label: ui('Restart DSH on {name}…', { name: currentName }) },
    ];
  }, [answer, attention, machines, selfName, currentName]);

  const select = (id: string) => {
    setOpen(false);
    if (id === 'restart') setRestarting(true);
    else if (id !== 'none') openMachine(id);
  };
  const title = waitingElsewhere ? ui('{name} · {count} waiting on other machines', { name: currentName, count: waitingElsewhere }) : ui('{name} · switch machine', { name: currentName });

  return <>
    <button ref={trigger} type="button" className="dm-trigger" data-wide={wide ? '' : undefined} aria-haspopup="menu" aria-expanded={open} title={title} aria-label={title} onClick={() => setOpen(value => !value)}>
      <StateDot state={dotOf(currentMachine, attention[current])} size={8} />
      {wide && <span className="dm-trigger-name">{currentName}</span>}
      {waitingElsewhere > 0 && <span className="dm-badge">{waitingElsewhere}</span>}
    </button>
    <Menu open={open} anchor={null} items={items} selectedId={current} onSelect={select} onClose={() => setOpen(false)} side="top" align="start" portal
      getAnchorRect={() => trigger.current?.getBoundingClientRect() ?? null} {...({ anchorRef: trigger } as object)} />
    <RestartDialog open={restarting} onClose={() => setRestarting(false)} name={currentName} />
  </>;
}
