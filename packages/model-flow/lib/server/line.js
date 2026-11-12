export const DEFAULT_ROUNDS = 3;
export const MAX_ROUNDS = 10;
const ROLE_WORDS = { plan: 'plan', impl: 'implement', implement: 'implement', review: 'review' };
const OPTION = /^(plan|impl|implement|review|rounds|wt|worktree|repo|branch)=(?:"([^"]*)"|“([^”]*)”|(\S+))(?:\s+|$)/iu;
const SWITCH = { on: true, yes: true, true: true, 1: true, off: false, no: false, false: false, 0: false };
export const USAGE = '/flow [plan=model] [impl=model] [review=model] [rounds=n] [wt=on|off] <goal>';
export function parseLine(raw, hasAttachments = false) {
    let rest = raw.trim();
    if (!rest && !hasAttachments)
        return { kind: 'status' };
    if (/^stop$/iu.test(rest))
        return { kind: 'stop' };
    const overrides = {}, place = {};
    let rounds;
    for (let match = OPTION.exec(rest); match; match = OPTION.exec(rest)) {
        const word = match[1].toLowerCase(), value = (match[2] ?? match[3] ?? match[4]).trim();
        if (word === 'rounds') {
            rounds = Number(value);
            if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)
                throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
        }
        else if (word === 'wt' || word === 'worktree') {
            const chosen = SWITCH[value.toLowerCase()];
            if (chosen === undefined)
                throw new Error('wt is on or off');
            place.worktree = chosen;
        }
        else if (word === 'repo' || word === 'branch') {
            if (!value)
                throw new Error(`${word}= needs a name`);
            place[word] = value;
        }
        else
            overrides[ROLE_WORDS[word]] = value;
        rest = rest.slice(match[0].length);
    }
    if (!rest && !hasAttachments)
        throw new Error(`Say what to do: ${USAGE}`);
    return { kind: 'run', goal: rest, overrides, ...(rounds === undefined ? {} : { rounds }), ...place };
}
