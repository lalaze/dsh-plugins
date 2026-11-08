/**
 * A /flow in the chat: one card per flow. While it runs, its steps are listed with their model, time and latest action;
 * when it ends, the steps fold away under the outcome and the report shows below. Rows of flows run before cards existed
 * are drawn as they were.
 */
import { DisclosureRow, IconApiOutlineRegular, MarkdownText, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cardWords, MARK, parseRow, type CardEnd, type CardState, type CardStep, type LiveCard, type RowParts, type StepStatus } from '../shared.js';
import { post } from './api.js';
import { i18n, ui, useLocale } from './i18n.js';

const POLL_MS = 1000;
/** Two in a row, so a card that just ended has time for its result to arrive. */
const GONE_AFTER = 2;

export const flowRowStyles = `
.mf-flow{display:flex;flex-direction:column;min-width:0}
.mf-flow-name{font-weight:400}
.mf-flow-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.mf-flow-summary{min-width:0;flex:auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-flow-summary[data-error],.mf-flow-summary[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.mf-flow-summary[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.mf-flow-open{flex:none;border:0;background:none;padding:0 6px;margin-left:4px;border-radius:4px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mf-flow-open:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-flow-open:disabled{color:var(--dsw-alias-label-tertiary);background:none;cursor:default}
.mf-flow-body{margin:4px 0 8px 4px;padding:12px 16px;max-height:480px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,8px);color:var(--dsw-alias-label-primary)}
.mf-flow-body[data-report]{max-height:none}
.mf-steps{display:grid;grid-template-columns:14px max-content minmax(0,max-content) max-content max-content max-content;justify-content:start;column-gap:12px;margin:2px 0 6px 2px;font-size:var(--dsh-content-font-size-secondary,13px)}
.mf-step{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;min-height:28px;padding:0 4px 0 6px;margin:0 -4px 0 -6px;border-radius:6px;color:var(--dsw-alias-label-secondary)}
.mf-step[role=button]{cursor:pointer}
.mf-step[role=button]:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-step[role=button]:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#517ee8);outline-offset:-2px}
.mf-step-label{white-space:nowrap;color:var(--dsw-alias-label-primary)}
.mf-step-model{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-step-machine{color:var(--dsw-alias-label-tertiary)}
.mf-step-time{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.mf-step-tag{font-size:12px;white-space:nowrap}
.mf-step-actions{display:flex;justify-content:flex-end;min-width:0}
.mf-step-actions .mf-flow-open{margin:0}
.mf-step-activity{grid-column:2/-1;margin:-4px 0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-step-body{grid-column:1/-1;margin:2px 0 8px}
.mf-status{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-label-tertiary)}
.mf-status[data-status=passed]{color:var(--dsw-alias-state-success-primary)}
.mf-status[data-status=sentBack],.mf-status[data-status=noVerdict]{color:var(--dsw-alias-state-warn-primary)}
.mf-status[data-status=failed]{color:var(--dsw-alias-state-error-primary)}
.mf-step[data-status=passed] .mf-step-tag{color:var(--dsw-alias-state-success-primary)}
.mf-step[data-status=sentBack] .mf-step-tag,.mf-step[data-status=noVerdict] .mf-step-tag{color:var(--dsw-alias-state-warn-primary)}
.mf-step[data-status=failed] .mf-step-tag{color:var(--dsw-alias-state-error-primary)}
.mf-step[data-status=stopped] .mf-step-tag{color:var(--dsw-alias-label-tertiary)}
.mf-spin{width:8px;height:8px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mf-spin .9s linear infinite}
@keyframes mf-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mf-spin{animation:none;border-right-color:currentColor;opacity:.6}}
/* The /flow line that started a card draws nothing: the card is the flow. */
[data-chat-flow-kind="command"]:has(.mf-flow-hidden){display:none}
/* A flow opening a conversation writes an empty turn (see ensureConversation), which says nothing but "done in 1 second". */
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"],
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"]+[data-chat-flow-kind="turn-tail"]{display:none}
`;

const ICON = <IconApiOutlineRegular size={14} />;
const HIDDEN = <div className="mf-flow mf-flow-hidden" />;
export interface CommandNode { commandId: string; name?: string | null; args?: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null }
type OpenStep = (parentId: string, childId: string) => void;
type Labels = React.ComponentProps<typeof MarkdownText>['labels'];

export function FlowRow({ node, openStep }: { node: CommandNode; openStep: OpenStep }) {
  useLocale();
  const parts = useMemo(() => parseRow(node.outcome?.text ?? ''), [node.outcome?.text]);
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
const END_TONE: Record<CardEnd['kind'], string | undefined> = { passed: undefined, rejected: 'warn', failed: 'error', stopped: undefined, noVerdict: 'error' };

function FlowCard({ node, parts, openStep }: { node: CommandNode; parts?: RowParts; openStep: OpenStep }) {
  const running = node.outcome === null, live = useLiveCard(running ? node.commandId : undefined);
  const [showSteps, setShowSteps] = useState<boolean | undefined>(undefined);
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(() => {
    setStopping(true);
    post({ action: 'stop', commandId: node.commandId }).catch(() => setStopping(false));
  }, [node.commandId]);
  const labels = useLabels();
  // Until the first answer, a running row may still turn out to be the /flow line itself.
  if (running && (!live.known || live.start)) return HIDDEN;

  const card: (CardState & Partial<Pick<LiveCard, 'elapsed' | 'activity'>>) | undefined = parts?.card ?? live.card;
  // A card left running by a DSH that stopped: it says how far it got, or how it ended if it got that far.
  const interrupted = running && !card?.end && (live.gone || !!live.card?.interrupted);
  const active = running && !interrupted && !!live.card && !live.card.end;
  const words = cardWords(card?.zh ?? i18n.activeLocale() === 'zh');
  const steps = card?.steps ?? [];
  let current: CardStep | undefined;
  for (let index = steps.length - 1; index >= 0 && !current; index--) if (steps[index].status === 'running') current = steps[index];
  const end = card?.end;
  const summary = interrupted ? words.interrupted
    : end ? words.summary(end)
    : current ? `${words.running(current.role, current.round)} · ${words.time(card?.elapsed ?? 0)}`
    : words.starting;
  const tone = interrupted ? 'error' : end ? END_TONE[end.kind] : undefined;
  const open = (showSteps ?? active) && steps.length > 0;
  const showMachine = new Set(steps.map(step => step.machine ?? '')).size > 1;
  const icon = interrupted ? <StatusIcon status="stopped" /> : end ? <StatusIcon status={END_STATUS[end.kind]} /> : ICON;
  const report = parts?.body;
  return <div className="mf-flow" data-state={active ? 'running' : tone === 'error' ? 'error' : 'done'}>
    <DisclosureRow icon={icon} title={node.name ?? 'flow'} titleClassName="mf-flow-name" running={active} open={open} expandable={steps.length > 0}
      expandOnRowClick keepContentWhenOpen onToggle={() => setShowSteps(!open)}
      collapsedContent={<>
        <span className="mf-flow-sep" data-shimmer-decoration aria-hidden />
        <span className="mf-flow-summary" title={card ? `${summary} · ${words.rounds(card.rounds)}` : summary} data-tone={tone}><TextShimmer>{summary}</TextShimmer></span>
      </>}
      headerAccessory={active ? <button type="button" className="mf-flow-open" disabled={stopping} onClick={stop}>{ui(stopping ? 'Stopping' : 'Stop')}</button> : undefined}>
      {open && card ? <div className="mf-steps">
        {steps.map((step, index) => <StepLine key={index} step={step} index={index} commandId={node.commandId} parentId={card.parentId} words={words} labels={labels}
          showMachine={showMachine} fetchable={running} interrupted={interrupted} activity={active && step === current ? card.activity : undefined} openStep={openStep} />)}
      </div> : undefined}
    </DisclosureRow>
    {/* The report has no fold: it is what the flow was for, and a report that cannot fold cannot be found folded. */}
    {report ? <div className="mf-flow-body" data-report><MarkdownText text={report} labels={labels} /></div> : undefined}
  </div>;
}

function StepLine({ step, index, commandId, parentId, words, labels, showMachine, fetchable, interrupted, activity, openStep }: {
  step: CardStep; index: number; commandId: string; parentId: string; words: ReturnType<typeof cardWords>; labels: Labels;
  showMachine: boolean; fetchable: boolean; interrupted: boolean; activity?: string; openStep: OpenStep;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<string | null | undefined>(undefined);
  const status: StepStatus = interrupted && step.status === 'running' ? 'stopped' : step.status;
  const body = step.body ?? fetched ?? undefined;
  // A running card sends its steps without their results, so an opened step asks for its own.
  const expandable = status !== 'running' && (body !== undefined || (fetchable && fetched === undefined));
  const toggle = () => {
    if (!expandable) return;
    if (!open && body === undefined) void post<{ body: string | null }>({ action: 'stepBody', commandId, index }).then(reply => setFetched(reply.body)).catch(() => setFetched(null));
    setOpen(!open);
  };
  const childId = step.childId;
  return <>
    <div className="mf-step" data-status={status} role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined}
      onClick={toggle} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } }}>
      <StatusIcon status={status} />
      <span className="mf-step-label">{words.step(step.role, step.round)}</span>
      <span className="mf-step-model" title={step.machine ? `${step.model} · ${step.machine}` : step.model}>
        {step.model}{showMachine && step.machine ? <span className="mf-step-machine"> · {step.machine}</span> : undefined}
      </span>
      <span className="mf-step-time">{step.ms !== undefined ? words.time(step.ms) : ''}</span>
      <span className="mf-step-tag">{words.tag(status)}</span>
      <span className="mf-step-actions">{childId
        ? <button type="button" className="mf-flow-open" onClick={event => { event.stopPropagation(); openStep(parentId, childId); }}>{ui('Open')}</button>
        : undefined}</span>
    </div>
    {activity ? <div className="mf-step-activity" title={activity}>{activity}</div> : undefined}
    {open && body ? <div className="mf-flow-body mf-step-body"><MarkdownText text={body} labels={labels} /></div> : undefined}
  </>;
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <span className="mf-status" data-status={status}><span className="mf-spin" aria-hidden /></span>;
  const shape = {
    done: <path d="M3.5 8.5l3 3 6-7" />,
    passed: <path d="M3.5 8.5l3 3 6-7" />,
    sentBack: <><path d="M6.5 3.5L3.5 6.5l3 3" /><path d="M3.5 6.5h6a3 3 0 010 6H8" /></>,
    noVerdict: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.3M8 10.8h.01" /></>,
    failed: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
    stopped: <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />,
  }[status];
  return <span className="mf-status" data-status={status}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{shape}</svg>
  </span>;
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
