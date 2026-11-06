/** The text after `/flow`. */
import type { Role } from './routes.js';

export const DEFAULT_ROUNDS = 3;
export const MAX_ROUNDS = 10;
export type FlowLine =
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'run'; goal: string; overrides: Partial<Record<Role, string>>; rounds?: number };

const ROLE_WORDS: Readonly<Record<string, Role>> = { plan: 'plan', impl: 'implement', implement: 'implement', review: 'review' };
const OPTION = /^(plan|impl|implement|review|rounds)=(\S+)(?:\s+|$)/iu;

export function parseLine(raw: string, hasAttachments = false): FlowLine {
  let rest = raw.trim();
  if (!rest && !hasAttachments) return { kind: 'status' };
  if (/^stop$/iu.test(rest)) return { kind: 'stop' };
  const overrides: Partial<Record<Role, string>> = {};
  let rounds: number | undefined;
  for (let match = OPTION.exec(rest); match; match = OPTION.exec(rest)) {
    const word = match[1].toLowerCase(), value = match[2];
    if (word === 'rounds') {
      rounds = Number(value);
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
    } else overrides[ROLE_WORDS[word]] = value;
    rest = rest.slice(match[0].length);
  }
  if (!rest && !hasAttachments) throw new Error('Say what to do: /flow [plan=model] [impl=model] [review=model] [rounds=n] <goal>');
  return { kind: 'run', goal: rest, overrides, ...(rounds === undefined ? {} : { rounds }) };
}
