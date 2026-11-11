/** What the models are told. English, as instructions for models; the bug itself stays in its own words. */
import type { Item, Route } from './domain.js';

export interface GoalInput {
  item: Item;
  /** The tracker the bug is in; absent for a bug a person typed in. */
  sourceName?: string;
  route: Pick<Route, 'name' | 'packageGlobs' | 'sharedPaths' | 'tests'>; baseBranch: string;
  packageHint?: string;
  /** What the person said when sending the fix back. */
  feedback?: string;
  /** The checks that failed after the previous round, with their output. */
  failedCheck?: string;
  /** Whether earlier rounds already changed (and maybe committed) files here. */
  continued: boolean;
  /** How many pictures the person added to what they said; they are attached after the bug's own. */
  feedbackPictures?: number;
  /** Which of the bug's pictures come attached, by their place in the bug from 0, in the order they are attached. */
  attached?: readonly number[];
}
const MAX_BODY = 12_000;

export function taskGoal(input: GoalInput): string {
  const { item, route, sourceName } = input, images = item.images ?? 0;
  const lines: string[] = [];
  if (input.failedCheck) lines.push('The fix for this bug was reviewed and passed, but the checks that run before it is committed failed. Fix what they report, without undoing the fix.', '', 'Failed checks:', input.failedCheck, '');
  else if (input.feedback !== undefined) {
    const own = (input.attached ?? []).length, added = input.feedbackPictures ?? 0;
    lines.push('A person looked at the fix for this bug and sent it back. Do what they ask; their words come first.', '', 'What they said:', input.feedback || '(nothing in words: see their pictures)');
    if (added) lines.push(`They added ${added} picture${added === 1 ? '' : 's'} showing what they mean: attachment${added === 1 ? '' : 's'} ${Array.from({ length: added }, (_, index) => own + index + 1).join(', ')}. Look at ${added === 1 ? 'it' : 'them'} first.`);
    lines.push('');
  }
  else lines.push(`Fix this bug, ${sourceName ? `reported in ${sourceName}` : 'written up by a person'}, in the repository ${route.name}.`, '');
  lines.push(`Bug ${item.ref}: ${item.title}`);
  if (item.url) lines.push(item.url);
  const facts = [item.project && `Project: ${item.project.name}`, item.module && `Module: ${item.module}`, item.priority && `Priority: ${item.priority}`, item.labels.length && `Labels: ${item.labels.join(', ')}`].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  lines.push('', 'Description:', item.body.trim() ? [...item.body.trim()].slice(0, MAX_BODY).join('') : '(none)');
  const attached = input.attached ?? [], missing = Array.from({ length: images }, (_, index) => index).filter(index => !attached.includes(index));
  const names = (indexes: readonly number[]) => indexes.map(index => `[image ${index + 1}]`).join(', ');
  if (attached.length) lines.push('', `The bug's pictures are attached: ${attached.map((index, at) => `attachment ${at + 1} is [image ${index + 1}]`).join(', ')}. Look at them before deciding what the bug is.`
    + (missing.length ? ` Not attached, because they could not be loaded: ${names(missing)}.` : ''));
  else if (images) lines.push('', `The bug has ${images} picture${images === 1 ? '' : 's'} (${names(missing)}) that could not be attached: work from the text, and say so if a picture was needed to understand the bug.`);
  lines.push('', 'Rules:',
    `- This is a worktree on a branch made for this bug from ${input.baseBranch}. Change only what this bug needs.`,
    '- Do not run git commit, git push, git merge or git reset, and do not switch branches: committing and pushing happen after a person accepts the fix.',
    sourceName ? `- Do not write to ${sourceName} or any other tracker.` : '- Do not write to any issue tracker.',
    '- Do not touch files with secrets (.env, .npmrc, keys) and do not add tokens or keys to the code.');
  if (input.continued) lines.push('- Earlier rounds already changed files here; `git log` and `git diff` show them. Build on that work instead of starting over.');
  if (route.packageGlobs.length) {
    // A preference, not a wall: a fix elsewhere is shown to the person as a warning, and a reviewer must not reject it for its place alone.
    lines.push(`- This repository holds several packages (${route.packageGlobs.join(', ')}). Find the one this bug is in and prefer to keep the fix inside it.`
      + (route.sharedPaths.length ? ` Shared code in ${route.sharedPaths.join(', ')} may be changed when the fix needs it.` : '')
      + ' When the code that is wrong really lives somewhere else, fix it where it is and say so; where a correct fix sits is not by itself a reason to reject it.');
    if (input.packageHint) lines.push(`- The person who assigned the bug expects it to be in ${input.packageHint}.`);
  }
  if (route.tests.length) lines.push('- After you finish, these checks run and must pass ({package} and {script} stand for the package you changed and its build script):', ...route.tests.map(command => `    ${command}`));
  return lines.join('\n');
}
const oneLine = (text: string) => text.split(/\s+/u).filter(Boolean).join(' ');
export const commitMessage = (item: Pick<Item, 'source' | 'ref' | 'title'>) => [...`fix(${item.source}): ${item.ref} ${oneLine(item.title)}`].slice(0, 160).join('');
export const mergeMessage = (item: Pick<Item, 'source' | 'id' | 'title'>) => [...`merge ${item.source} fix ${item.id}: ${oneLine(item.title)}`].slice(0, 200).join('');
export const conversationTitle = (item: Pick<Item, 'ref' | 'title'>) => [...`${item.ref} ${oneLine(item.title)}`].slice(0, 80).join('');
/** A branch for the bug: the source, then what names the bug there, kept to what Git allows in a ref. */
export const branchName = (item: Pick<Item, 'source' | 'id'>) => `${item.source}/${item.id.split('/').map(part => part.replace(/[^\w.-]+/gu, '-').replace(/^[-.]+|[-.]+$/gu, '')).filter(Boolean).join('/') || 'bug'}`;
