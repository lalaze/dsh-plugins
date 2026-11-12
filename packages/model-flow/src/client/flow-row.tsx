/**
 * A /flow in the chat: one card per flow. While it runs, the card shows what is happening, a progress bar over every step
 * the flow can still take, and a timeline of its steps; when it ends, the outcome tops the card, the steps fold away and
 * the report is part of the card. Rows of flows run before cards existed are drawn as they were.
 */
import { DisclosureRow, IconApiOutlineRegular, MarkdownText, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { firstLine } from '../activity.js';
import type { Role } from '../routes.js';
import { cardWords, clock, MARK, parseRow, type CardEnd, type CardState, type CardStep, type LiveCard, type RowParts, type StepStatus } from '../shared.js';
import { post } from './api.js';
import { claimant, extensionFor, useExtensions, type CommandNode, type FlowView, type Stage, type ViewExtras } from './extend.js';
import { i18n, ui, useLocale } from './i18n.js';

const POLL_MS = 1000;
/** Two in a row, so a card that just ended has time for its result to arrive. */
const GONE_AFTER = 2;

const cardStyles = `
.mf-card{--mf-line:color-mix(in srgb,var(--dsw-alias-label-primary,#222) 10%,transparent);--mf-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#222) 5%,transparent));
  --mf-run:var(--dsw-alias-state-business-primary,#4d6bfe);--mf-run-soft:color-mix(in srgb,var(--mf-run) 10%,transparent);
  --mf-ok:var(--dsw-alias-state-success-primary,#16a34a);--mf-warn:var(--dsw-alias-state-warn-primary,#d97706);--mf-err:var(--dsw-alias-state-error-primary,#dc2626);--mf-idle:var(--dsw-alias-label-tertiary,#999);
  container-type:inline-size;display:block;margin:4px 0 8px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 74%,transparent);border:1px solid var(--dsw-alias-border-l1,var(--mf-line));border-radius:12px;
  box-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 20px rgba(0,0,0,.06);-webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);overflow:hidden}
.mf-card-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:12px;align-items:center;padding:14px 16px 10px}
.mf-card-mark{grid-row:span 2;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--mf-idle)}
.mf-card-mark[data-status=running]{background:var(--mf-run-soft);color:var(--mf-run)}
.mf-card-mark[data-status=passed]{background:var(--mf-ok)}
.mf-card-mark[data-status=sentBack]{background:var(--mf-warn)}
.mf-card-mark[data-status=failed],.mf-card-mark[data-status=noVerdict]{background:var(--mf-err)}
.mf-card-title{font-size:15px;font-weight:600;line-height:22px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-card-detail{grid-column:2;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-card[data-status=failed] .mf-card-detail{color:var(--mf-err)}
.mf-card-side{grid-row:1/span 2;grid-column:3;display:flex;align-items:center;gap:10px}
.mf-card-clock{font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.mf-card-stop{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:none;border:1px solid var(--dsw-alias-border-l2,var(--mf-line));border-radius:999px;padding:3px 11px;cursor:pointer}
.mf-card-stop:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--mf-hover)}
.mf-card-stop:disabled{opacity:.6;cursor:default}
.mf-track{display:grid;column-gap:6px;padding:0 16px}
.mf-track-group{display:flex;flex-direction:column;gap:5px;min-width:0}
.mf-track-segs{display:flex;gap:3px}
.mf-seg{flex:1;height:5px;border-radius:3px;background:var(--mf-line);position:relative;overflow:hidden}
.mf-seg[data-status=done]{background:color-mix(in srgb,var(--mf-idle) 75%,transparent)}
.mf-seg[data-status=passed]{background:var(--mf-ok)}
.mf-seg[data-status=sentBack],.mf-seg[data-status=noVerdict]{background:var(--mf-warn)}
.mf-seg[data-status=failed]{background:var(--mf-err)}
.mf-seg[data-status=stopped]{background:color-mix(in srgb,var(--mf-idle) 45%,transparent)}
.mf-seg[data-status=running]{background:var(--mf-run-soft)}
.mf-seg[data-status=running]::after{content:"";position:absolute;inset:0;width:45%;border-radius:3px;background:var(--mf-run);animation:mf-slide 1.6s ease-in-out infinite}
.mf-seg[data-status=skipped]{background:none;height:3px;margin-top:1px;border:1px dashed var(--mf-line);box-sizing:border-box}
.mf-track-label{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
@keyframes mf-slide{0%{transform:translateX(-100%)}100%{transform:translateX(230%)}}
.mf-card-toggle{display:flex;align-items:center;gap:6px;width:100%;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);background:none;border:0;border-top:1px solid var(--mf-line);padding:9px 16px;margin-top:12px;cursor:pointer;text-align:left}
.mf-card-toggle:hover{color:var(--dsw-alias-label-primary)}
.mf-card-toggle svg{transition:transform .15s}
.mf-card-toggle[aria-expanded=true] svg{transform:rotate(90deg)}
.mf-steps{list-style:none;margin:12px 0 0;padding:6px 8px 8px;border-top:1px solid var(--mf-line);display:grid;grid-template-columns:22px max-content minmax(0,1fr) max-content max-content;column-gap:10px}
.mf-card-toggle+.mf-steps{margin-top:0;border-top:0;padding-top:0}
.mf-step{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;padding:6px 8px;border-radius:8px;position:relative}
.mf-step[data-expandable]{cursor:pointer}
.mf-step[data-expandable]:hover{background:var(--mf-hover)}
.mf-step[data-expandable]:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--mf-run));outline-offset:-2px}
.mf-step[data-status=running]{background:var(--mf-run-soft)}
.mf-step:not(:last-child)::before{content:"";position:absolute;left:18px;top:26px;bottom:-6px;width:1.5px;background:var(--mf-line)}
.mf-node{width:20px;height:20px;box-sizing:border-box;border-radius:50%;display:grid;place-items:center;position:relative;z-index:1;color:var(--dsw-alias-label-tertiary);border:1.5px solid var(--mf-line);background:var(--dsw-alias-bg-layer-1,#fff)}
.mf-node[data-status=done]{color:var(--dsw-alias-label-secondary);border-color:color-mix(in srgb,var(--mf-idle) 60%,transparent)}
.mf-node[data-status=running]{color:var(--mf-run);border-color:var(--mf-run)}
.mf-node[data-status=passed]{color:#fff;background:var(--mf-ok);border-color:var(--mf-ok)}
.mf-node[data-status=sentBack],.mf-node[data-status=noVerdict]{color:#fff;background:var(--mf-warn);border-color:var(--mf-warn)}
.mf-node[data-status=failed]{color:#fff;background:var(--mf-err);border-color:var(--mf-err)}
.mf-step-name{font-weight:500;white-space:nowrap}
.mf-step-model{min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-step-machine{color:var(--dsw-alias-label-tertiary)}
.mf-step-time{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.mf-step-open{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);background:none;border:0;padding:1px 6px;border-radius:5px;cursor:pointer}
.mf-step-open:hover{color:var(--dsw-alias-label-primary);background:var(--mf-hover)}
.mf-tag{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;font-size:11px;line-height:17px;font-weight:400;vertical-align:1px}
.mf-tag[data-status=passed]{color:var(--mf-ok);background:color-mix(in srgb,var(--mf-ok) 14%,transparent)}
.mf-tag[data-status=sentBack],.mf-tag[data-status=noVerdict]{color:var(--mf-warn);background:color-mix(in srgb,var(--mf-warn) 14%,transparent)}
.mf-tag[data-status=failed]{color:var(--mf-err);background:color-mix(in srgb,var(--mf-err) 14%,transparent)}
.mf-tag[data-status=stopped]{color:var(--dsw-alias-label-tertiary);background:var(--mf-hover)}
/* Lines across the columns must not size them: a long one would spread the columns over the whole width. */
.mf-step-note{grid-column:2/-1;contain:inline-size;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-step[data-status=sentBack] .mf-step-note,.mf-step[data-status=noVerdict] .mf-step-note{color:var(--mf-warn)}
.mf-step[data-status=failed] .mf-step-note{color:var(--mf-err)}
.mf-step-body{grid-column:2/-1;contain:inline-size;margin:6px 0 2px;padding:10px 12px;max-height:420px;overflow:auto;border-radius:8px;border:1px solid var(--mf-line);cursor:auto}
.mf-card-report{border-top:1px solid var(--mf-line);padding:12px 16px 14px;font-size:var(--dsh-content-font-size,14px)}
.mf-card-caption{padding:12px 16px 0;min-width:0}
.mf-card-caption+.mf-card-head{padding-top:10px}
.mf-card-more{border-top:1px solid var(--mf-line);margin-top:12px;padding:12px 16px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.mf-card-report+.mf-card-more,.mf-steps+.mf-card-more{margin-top:0}
.mf-seg[data-status=pending]{background:var(--mf-line)}
.mf-spin{display:block;width:8px;height:8px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mf-spin .9s linear infinite}
.mf-card-mark .mf-spin{width:12px;height:12px;border-width:1.8px}
@keyframes mf-spin{to{transform:rotate(360deg)}}
@container (max-width:460px){
  .mf-steps{grid-template-columns:22px minmax(0,1fr) max-content max-content}
  .mf-step-model{grid-column:2/-1;grid-row:2;font-size:12px}
  .mf-card-clock{font-size:13px}
}
@media (prefers-reduced-motion:reduce){.mf-spin,.mf-seg[data-status=running]::after{animation:none}.mf-spin{border-right-color:currentColor;opacity:.6}}
`;

/** Rows that are not cards, and what hides the /flow line and the empty turn a flow may write. */
const rowStyles = `
.mf-flow{display:flex;flex-direction:column;min-width:0}
.mf-flow-name{font-weight:400}
.mf-flow-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.mf-flow-summary{min-width:0;flex:auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-flow-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
.mf-flow-open{flex:none;border:0;background:none;padding:0 6px;margin-left:4px;border-radius:4px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mf-flow-open:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-flow-body{margin:4px 0 8px 4px;padding:12px 16px;max-height:480px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,8px);color:var(--dsw-alias-label-primary)}
.mf-flow-body[data-report]{max-height:none}
/* The /flow line that started a card draws nothing: the card is the flow. */
[data-chat-flow-kind="command"]:has(.mf-flow-hidden){display:none}
/* A flow opening a conversation writes an empty turn (see ensureConversation), which says nothing but "done in 1 second". */
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"],
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"]+[data-chat-flow-kind="turn-tail"]{display:none}
`;
export const flowRowStyles = rowStyles + cardStyles;

const ICON = <IconApiOutlineRegular size={14} />;
const HIDDEN = <div className="mf-flow mf-flow-hidden" />;
export type { CommandNode };
type OpenStep = (parentId: string, childId: string) => void;
type Labels = React.ComponentProps<typeof MarkdownText>['labels'];
type Words = ReturnType<typeof cardWords>;

export function FlowRow({ node, openStep }: { node: CommandNode; openStep: OpenStep }) {
  useLocale(); useExtensions();
  const parts = useMemo(() => parseRow(node.outcome?.text ?? ''), [node.outcome?.text]);
  // A line handed over to another plugin (a flow in a worktree of its own) was answered by that plugin: it draws the row.
  const other = node.outcome?.text ? claimant(node.outcome.text) : undefined;
  if (other?.Row) return <other.Row node={node} />;
  if (parts.card) return <FlowCard node={node} parts={parts} openStep={openStep} />;
  if (parts.start) return HIDDEN;
  if (node.outcome === null) {
    // A typed /flow being handled draws nothing until its result says what it was; the flow's own card carries the mark.
    const args = typeof node.args === 'string' ? node.args.trimStart() : undefined;
    return args !== undefined && !args.startsWith(MARK) ? HIDDEN : <FlowCard node={node} openStep={openStep} />;
  }
  return <PlainRow node={node} parts={parts} openStep={openStep} />;
}

function useLiveCard(commandId: string | undefined): { card?: LiveCard; start?: boolean; known: boolean; gone: boolean } {
  const [state, setState] = useState<{ card?: LiveCard; start?: boolean; known: boolean; gone: boolean }>({ known: false, gone: false });
  useEffect(() => {
    if (!commandId) return undefined;
    let alive = true, misses = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const reply = await post<{ card?: LiveCard; start?: boolean }>({ action: 'card', commandId });
        if (!alive) return;
        misses = reply.card || reply.start ? 0 : misses + 1;
        setState({ ...(reply.card ? { card: reply.card } : {}), ...(reply.start ? { start: true } : {}), known: true, gone: misses >= GONE_AFTER });
        if (misses >= GONE_AFTER || reply.card?.interrupted) return;
      } catch { /* A dropped request says nothing about the card. */ }
      if (alive) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [commandId]);
  return state;
}

const useLabels = (): Labels => useMemo(() => ({ code: { copyLabel: ui('Copy'), copiedLabel: ui('Copied') }, footnotes: ui('Footnotes') }), []);
const END_STATUS: Record<CardEnd['kind'], StepStatus> = { passed: 'passed', rejected: 'sentBack', failed: 'failed', stopped: 'stopped', noVerdict: 'noVerdict' };
const NOTED = new Set<StepStatus>(['sentBack', 'noVerdict', 'failed']);

function FlowCard({ node, parts, openStep }: { node: CommandNode; parts?: RowParts; openStep: OpenStep }) {
  const running = node.outcome === null, live = useLiveCard(running ? node.commandId : undefined);
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(() => {
    setStopping(true);
    post({ action: 'stop', commandId: node.commandId }).catch(() => setStopping(false));
  }, [node.commandId]);
  const stepBody = useCallback((index: number) => post<{ body: string | null }>({ action: 'stepBody', commandId: node.commandId, index }).then(reply => reply.body, () => null), [node.commandId]);
  useExtensions();
  // Until the first answer, a running row may still turn out to be the /flow line itself.
  if (running && (!live.known || live.start)) return HIDDEN;

  const card: FlowView['card'] | undefined = parts?.card ?? live.card;
  if (!card) return <FlowCardView card={{ parentId: '', zh: i18n.activeLocale() === 'zh', rounds: 0, steps: [] }} active={false} interrupted={running && live.gone} bare openStep={openStep} />;
  // A card left running by a DSH that stopped: it says how far it got, or how it ended if it got that far.
  const interrupted = running && !card.end && (live.gone || !!live.card?.interrupted);
  const view: FlowView = {
    card, active: running && !interrupted && !!live.card && !card.end, interrupted, stop, stopping,
    ...(parts?.body ? { report: parts.body } : {}), ...(running ? { stepBody } : {}),
  };
  // The plugin that started this flow may draw its card: the same card, with what it has to add.
  const Own = extensionFor(card.tag)?.Card;
  return Own ? <Own tag={card.tag!} flow={view} /> : <FlowCardView {...view} openStep={openStep} />;
}

/**
 * The card itself: what is happening, the progress bar, the steps and the report. Another plugin draws its own flows
 * with it too, through the client service `modelFlowCard`, and says what stands around them.
 */
export function FlowCardView({ card, active, interrupted = false, report, stop, stopping, stepBody, canOpen = true, head, stages = [], caption, children, bare, openStep }: FlowView & ViewExtras & { bare?: boolean; openStep: OpenStep }) {
  const [showSteps, setShowSteps] = useState<boolean | undefined>(undefined);
  const labels = useLabels();
  const end = card.end;
  const words = cardWords(card.zh);
  const steps = card.steps;
  let current: CardStep | undefined;
  for (let index = steps.length - 1; index >= 0 && !current; index--) if (steps[index].status === 'running') current = steps[index];
  const status: StepStatus = head?.status ?? (interrupted ? 'stopped' : end ? END_STATUS[end.kind] : 'running');
  const title = head?.title ?? (interrupted ? words.interrupted : end ? words.title(end) : current ? words.running(current.role, current.round) : words.starting);
  const detail = head ? head.detail ?? '' : interrupted ? words.interruptedDetail
    : end ? words.detail(end, steps.at(-1))
    : current ? words.doing(current, steps.filter(step => step.status === 'sentBack').length, card.rounds)
    : bare ? '' : words.rounds(card.rounds);
  const elapsed = head && head.clock !== undefined ? head.clock ?? undefined : end ? end.ms : interrupted ? undefined : card.elapsed;
  const open = showSteps ?? !end;
  const showMachine = new Set(steps.map(step => step.machine ?? '')).size > 1;
  return <div className="mf-flow mf-card" data-status={status}>
    {caption ? <div className="mf-card-caption">{caption}</div> : undefined}
    <div className="mf-card-head">
      <span className="mf-card-mark" data-status={status}>{status === 'running' ? <span className="mf-spin" aria-hidden /> : <Glyph status={status} size={14} />}</span>
      <span className="mf-card-title" title={title}>{title}</span>
      <span className="mf-card-detail" title={detail}>{detail}</span>
      <span className="mf-card-side">
        {elapsed !== undefined ? <span className="mf-card-clock">{clock(elapsed)}</span> : undefined}
        {active && stop ? <button type="button" className="mf-card-stop" disabled={stopping} onClick={stop}>{ui(stopping ? 'Stopping' : 'Stop')}</button> : undefined}
      </span>
    </div>
    {bare ? undefined : <Track card={card} words={words} over={!!end || interrupted} interrupted={interrupted} stages={stages} />}
    {end && steps.length ? <button type="button" className="mf-card-toggle" aria-expanded={open} onClick={() => setShowSteps(!open)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3.5l4.5 4.5L6 12.5" /></svg>
      {open ? words.hideSteps : words.showSteps(steps.length)}
    </button> : undefined}
    {open && steps.length ? <ol className="mf-steps">
      {steps.map((step, index) => <StepLine key={index} step={step} index={index} parentId={card.parentId} words={words} labels={labels}
        showMachine={showMachine} fetchBody={stepBody} interrupted={interrupted} activity={active && step === current ? card.activity : undefined} openStep={canOpen && card.parentId ? openStep : undefined} />)}
    </ol> : undefined}
    {/* The report has no fold: it is what the flow was for, and a report that cannot fold cannot be found folded. */}
    {report ? <div className="mf-card-report"><MarkdownText text={report} labels={labels} /></div> : undefined}
    {children ? <div className="mf-card-more">{children}</div> : undefined}
  </div>;
}

/** Every step the flow can still take: the plan, then each round's implement and review, up to the most rounds; then what follows the flow. */
function Track({ card, words, over, interrupted, stages }: { card: CardState; words: Words; over: boolean; interrupted: boolean; stages: readonly Stage[] }) {
  const planned = card.planned ?? card.steps.some(step => step.role === 'plan');
  const slot = (role: Role, round: number): string => {
    let status: StepStatus | undefined;
    for (const step of card.steps) if (step.role === role && step.round === round) status = step.status;
    if (status === 'running' && interrupted) return 'stopped';
    return status ?? (over ? 'skipped' : 'pending');
  };
  const groups = [
    ...(planned ? [{ label: words.roleName('plan'), slots: [slot('plan', 0)] }] : []),
    ...Array.from({ length: card.rounds }, (_, index) => ({ label: words.round(index + 1), slots: [slot('implement', index + 1), slot('review', index + 1)] })),
    ...stages.map(stage => ({ label: stage.label, slots: [stage.status as string] })),
  ];
  const labelled = groups.length <= 6;
  return <div className="mf-track" style={{ gridTemplateColumns: groups.map(group => `${group.slots.length}fr`).join(' ') }}>
    {groups.map((group, index) => <div key={index} className="mf-track-group">
      <div className="mf-track-segs">{group.slots.map((status, at) => <span key={at} className="mf-seg" data-status={status} />)}</div>
      {labelled ? <span className="mf-track-label">{group.label}</span> : undefined}
    </div>)}
  </div>;
}

function StepLine({ step, index, parentId, words, labels, showMachine, fetchBody, interrupted, activity, openStep }: {
  step: CardStep; index: number; parentId: string; words: Words; labels: Labels;
  showMachine: boolean; fetchBody?: (index: number) => Promise<string | null>; interrupted: boolean; activity?: string; openStep?: OpenStep;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<string | null | undefined>(undefined);
  const status: StepStatus = interrupted && step.status === 'running' ? 'stopped' : step.status;
  const body = step.body ?? fetched ?? undefined;
  // A running card sends its steps without their results, so an opened step asks for its own.
  const expandable = status !== 'running' && (body !== undefined || (!!fetchBody && fetched === undefined));
  const toggle = () => {
    if (!expandable) return;
    if (!open && body === undefined && fetchBody) void fetchBody(index).then(setFetched, () => setFetched(null));
    setOpen(!open);
  };
  const note = activity || (NOTED.has(status) ? step.note ?? (step.body ? firstLine(step.body) : undefined) : undefined);
  const tag = words.tag(status), childId = step.childId;
  return <li className="mf-step" data-status={status} data-expandable={expandable || undefined} tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined}
    onClick={toggle} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } }}>
    <span className="mf-node" data-status={status}>{status === 'running' ? <span className="mf-spin" aria-hidden /> : <Glyph status={status} size={11} />}</span>
    <span className="mf-step-name">{words.step(step.role, step.round)}{tag ? <span className="mf-tag" data-status={status}>{tag}</span> : undefined}</span>
    <span className="mf-step-model" title={step.machine ? `${step.model} · ${step.machine}` : step.model}>
      {step.model}{showMachine && step.machine ? <span className="mf-step-machine"> · {step.machine}</span> : undefined}
    </span>
    <span className="mf-step-time">{step.ms !== undefined ? words.time(step.ms) : ''}</span>
    <span>{childId && openStep ? <button type="button" className="mf-step-open" onClick={event => { event.stopPropagation(); openStep(parentId, childId); }}>{ui('Open')}</button> : undefined}</span>
    {note ? <span className="mf-step-note" title={note}>{note}</span> : undefined}
    {open && body ? <div className="mf-step-body" onClick={event => event.stopPropagation()}><MarkdownText text={body} labels={labels} /></div> : undefined}
  </li>;
}

function Glyph({ status, size }: { status: StepStatus; size: number }) {
  const shape = {
    running: null,
    done: <path d="M3.5 8.5l3 3 6-7" />,
    passed: <path d="M3.5 8.5l3 3 6-7" />,
    sentBack: <><path d="M6.5 3.5L3.5 6.5l3 3" /><path d="M3.5 6.5h6a3 3 0 010 6H8" /></>,
    noVerdict: <path d="M8 3.5v5.5M8 12.2h.01" />,
    failed: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
    stopped: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  }[status];
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{shape}</svg>;
}

/** Rows that are not a card: errors, /flow and /flow stop replies, and every row of a flow run before cards existed. */
function PlainRow({ node, parts, openStep }: { node: CommandNode; parts: RowParts; openStep: OpenStep }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(value => !value), []);
  const labels = useLabels();
  const failed = node.outcome?.kind === 'error';
  const summary = parts.title || ui(failed ? 'Failed' : 'Done');
  const { parentId, childId, body } = parts;
  // An old flow's last row is its report, with no fold, for the same reason as a card's.
  const report = parts.open === true && body !== undefined;
  const open = !report && expanded && body !== undefined;
  return <div className="mf-flow" data-state={failed ? 'error' : 'done'}>
    <DisclosureRow icon={ICON} title={node.name ?? 'flow'} titleClassName="mf-flow-name" open={open} expandable={!report && body !== undefined}
      expandOnRowClick keepContentWhenOpen onToggle={toggle}
      collapsedContent={<>
        <span className="mf-flow-sep" data-shimmer-decoration aria-hidden />
        <span className="mf-flow-summary" title={summary} data-error={failed || undefined}><TextShimmer>{summary}</TextShimmer></span>
      </>}
      headerAccessory={parentId && childId ? <button type="button" className="mf-flow-open" onClick={() => openStep(parentId, childId)}>{ui('Open')}</button> : undefined}>
      {open ? <div className="mf-flow-body"><MarkdownText text={body} labels={labels} /></div> : undefined}
    </DisclosureRow>
    {report ? <div className="mf-flow-body" data-report><MarkdownText text={body} labels={labels} /></div> : undefined}
  </div>;
}
