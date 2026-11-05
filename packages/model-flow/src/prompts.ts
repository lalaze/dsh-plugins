/** What each model is told. The goal's own language is kept in every reply. */
export const VERDICT_MARK = 'FLOW_VERDICT';
const language = 'Write in the language of the goal.';
const section = (title: string, body: string | undefined) => body?.trim() ? `\n\n## ${title}\n${body.trim()}` : '';

export const planPrompt = (goal: string) => `You are the planner. Another model will implement your plan and a third will review the result. Read what you need, but do not change anything.

Write a plan for the goal: the steps, the files likely to change, and a section "Acceptance criteria" with numbered checks a reviewer can verify, including any command to run. Stay within what the goal asks. Do not ask questions: when something is unclear, choose the simplest reading and say so. ${language}${section('Goal', goal)}`;

export const implementPrompt = (input: { goal: string; plan?: string; round: number; findings?: string; lastSummary?: string }) => `You are the implementer. Do the work in this working directory and run the checks you can. Do not commit unless the goal says to. Do not ask questions: nobody can answer them here. End with a short summary of what changed and what you verified, including anything you could not do. ${language}${input.round > 1 ? `

A reviewer sent back the previous round. Its changes are already in the working tree: fix them there, do not start over. Fix every finding below, or say why one is wrong.` : ''}${section('Goal', input.goal)}${section('Plan', input.plan)}${section('Review findings to fix', input.findings)}${section('Summary from the previous round', input.lastSummary)}`;

export const reviewPrompt = (input: { goal: string; plan?: string; round: number; summary?: string; findings?: string }) => `You are the reviewer, independent of the implementer. You work read-only: never change a file. Check the work against the goal and the acceptance criteria.

Look at the changes yourself with git status and git diff, and read the code. Treat the implementer's summary as claims to check. Uncommitted changes unrelated to the goal may predate this work: ignore them. Run the checks where this read-only session allows it, and say which you could not run. Report only real problems: bugs, unmet criteria, or missing work the goal asks for. Do not ask for style changes. ${language}${input.round > 1 ? '\n\nThis is a re-review: confirm that the earlier findings are fixed, and look for anything the fixes broke.' : ''}

If there are problems, list each with its file and what to change. The very last line of your reply must be exactly one of:
${VERDICT_MARK}: pass
${VERDICT_MARK}: needs_revision${section('Goal', input.goal)}${section('Plan', input.plan)}${section('Implementer summary', input.summary)}${section('Findings from the previous review', input.findings)}`;

export const retryVerdictNote = `\n\nYour reply must end with a line that is exactly "${VERDICT_MARK}: pass" or "${VERDICT_MARK}: needs_revision". A previous review of this work left that line out.`;

export type Verdict = 'pass' | 'needs_revision';
/** The last verdict line decides, in case the reply quotes the format earlier on. Markdown around it is ignored. */
export function parseVerdict(text: string): { verdict?: Verdict; body: string } {
  const pattern = new RegExp(`^[^\\w\\n]*${VERDICT_MARK}[^\\w\\n]*(pass|needs_revision)\\b[^\\w\\n]*$`, 'gimu');
  let last: RegExpExecArray | undefined;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) last = match;
  if (!last) return { body: text.trim() };
  return { verdict: last[1].toLowerCase() as Verdict, body: (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim() };
}
