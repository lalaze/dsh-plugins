/** How the page words and colours a machine. */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { MachineAttention } from '../attention-board.js';
import type { MachineInfo } from '../model.js';
import { formatLocale, ui } from './i18n.js';

export function since(time: number | undefined): string {
  if (!time) return '';
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(formatLocale(), { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(Math.round(seconds), 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'no-listener': return ui('Plugin not running there');
    case 'timeout': return ui('No answer');
    case 'forbidden': return ui('Refused this computer');
    case 'not-plugin': return ui('Not a DSH with this plugin');
    case undefined: case '': return ui('Unreachable');
    default: return reason;
  }
}

/** The dot: waiting beats running beats ready; a machine no link reaches is red, one that is away grey. */
export function dotOf(machine: Pick<MachineInfo, 'state'> | undefined, attention: MachineAttention | undefined): StateDotState {
  if (machine && machine.state === 'offline') return 'idle';
  if (machine && machine.state === 'unreachable') return 'error';
  if (attention?.waiting.length) return 'warning';
  if (attention?.running.length) return 'ongoing';
  return 'done';
}

/** The short note at the end of a machine's menu row: only what the dot cannot say ('' when it is just ready). */
export function noteOf(machine: Pick<MachineInfo, 'state'> | undefined, attention: MachineAttention | undefined, self: boolean): string {
  if (machine?.state === 'offline') return ui('Offline');
  if (machine?.state === 'unreachable') return ui('Unreachable');
  const parts: string[] = [];
  if (self) parts.push(ui('This computer'));
  const waiting = attention?.waiting.length ?? 0;
  if (waiting) parts.push(ui('{count} waiting', { count: waiting }));
  const running = attention?.running.length ?? 0;
  if (running) parts.push(ui('{count} running', { count: running }));
  else if (!waiting && attention?.finished.length) parts.push(ui('{count} finished', { count: attention.finished.length }));
  return parts.join(' · ');
}

/** One line under a machine's name. */
export function summaryOf(machine: MachineInfo | undefined, attention: MachineAttention | undefined, self: boolean): string {
  if (machine?.state === 'offline') return machine.lastSeen ? ui('Offline · seen {time}', { time: since(machine.lastSeen) }) : ui('Offline');
  if (machine?.state === 'unreachable') return reasonText(machine.reason);
  const parts: string[] = [];
  if (self) parts.push(ui('This computer'));
  const waiting = attention?.waiting.length ?? 0;
  if (waiting) parts.push(ui('{count} waiting', { count: waiting }));
  const running = attention?.running.length ?? 0;
  if (running) parts.push(ui('{count} running', { count: running }));
  const finished = attention?.finished.length ?? 0;
  if (finished) parts.push(ui('{count} finished', { count: finished }));
  if (parts.length === (self ? 1 : 0)) parts.push(ui('Ready'));
  return parts.join(' · ');
}
