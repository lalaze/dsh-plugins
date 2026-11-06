/** A /flow row: one step from running to result, with the latest thing it does and the whole result one click away. */
import { DisclosureRow, IconApiOutlineRegular, MarkdownText, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { parseRow, type LiveStep } from '../shared.js';
import { post } from './api.js';
import { ui, useLocale } from './i18n.js';

const POLL_MS = 1000;
/** Two in a row, so a step that just ended has time for its result to arrive. */
const GONE_AFTER = 2;

export const flowRowStyles = `
.mf-flow{display:flex;flex-direction:column;min-width:0}
.mf-flow-name{font-weight:400}
.mf-flow-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.mf-flow-summary{min-width:0;flex:auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-flow-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
.mf-flow-elapsed{flex:none;margin-left:6px;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mf-flow-open{flex:none;border:0;background:none;padding:0 6px;margin-left:4px;border-radius:4px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mf-flow-open:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-flow-activity{margin-left:22px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-flow-body{margin:4px 0 8px 4px;padding:12px 16px;max-height:480px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,8px);color:var(--dsw-alias-label-primary)}
.mf-flow-body[data-report]{max-height:none}
/* A flow opening a conversation writes an empty turn (see ensureConversation), which says nothing but "done in 1 second". */
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"],
[data-chat-flow-kind="command"]:first-child:has(.mf-flow)+[data-chat-flow-kind="turn-process"]+[data-chat-flow-kind="turn-tail"]{display:none}
`;

function useLiveStep(commandId: string | undefined): { step?: LiveStep; gone: boolean } {
  const [state, setState] = useState<{ step?: LiveStep; gone: boolean }>({ gone: false });
  useEffect(() => {
    if (!commandId) return undefined;
    let alive = true, misses = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { step } = await post<{ step: LiveStep | null }>({ action: 'step', commandId });
        if (!alive) return;
        misses = step ? 0 : misses + 1;
        setState({ ...(step ? { step } : {}), gone: misses >= GONE_AFTER });
        if (misses >= GONE_AFTER) return;
      } catch { /* A dropped request says nothing about the step. */ }
      if (alive) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [commandId]);
  return state;
}

const ICON = <IconApiOutlineRegular size={14} />;
export interface CommandNode { commandId: string; name?: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null }

export function FlowRow({ node, openStep }: { node: CommandNode; openStep(parentId: string, childId: string): void }) {
  useLocale();
  const running = node.outcome === null, live = useLiveStep(running ? node.commandId : undefined);
  const parts = useMemo(() => parseRow(node.outcome?.text ?? ''), [node.outcome?.text]);
  // Stays open once it arrives: the row that ends a flow is the report, so it reads without a click.
  const [folded, setFolded] = useState<boolean | undefined>(undefined);
  const expanded = folded === undefined ? parts.open === true : !folded;
  const toggle = useCallback(() => setFolded(expanded), [expanded]);
  // A row with no result that this DSH knows nothing about was running when DSH last stopped.
  const interrupted = running && live.gone, active = running && !interrupted;
  const failed = node.outcome?.kind === 'error' || interrupted;
  const summary = interrupted ? ui('Stopped when DSH closed')
    : running ? live.step?.title ?? ui('Starting')
    : parts.title || ui(failed ? 'Failed' : 'Done');
  const parentId = running ? live.step?.parentId : parts.parentId, childId = running ? live.step?.childId : parts.childId;
  const body = running ? undefined : parts.body, activity = active ? live.step?.activity : undefined;
  const labels = useMemo(() => ({ code: { copyLabel: ui('Copy'), copiedLabel: ui('Copied') }, footnotes: ui('Footnotes') }), []);
  const open = expanded && body !== undefined;
  return <div className="mf-flow" data-state={active ? 'running' : failed ? 'error' : 'done'}>
    <DisclosureRow icon={ICON} title={node.name ?? 'flow'} titleClassName="mf-flow-name" running={active} open={open} expandable={body !== undefined}
      expandOnRowClick keepContentWhenOpen onToggle={toggle}
      collapsedContent={<>
        <span className="mf-flow-sep" data-shimmer-decoration aria-hidden />
        <span className="mf-flow-summary" title={summary} data-error={failed || undefined}><TextShimmer>{summary}</TextShimmer></span>
      </>}
      headerAccessory={<>
        {active && live.step ? <span className="mf-flow-elapsed">{live.step.elapsed}</span> : undefined}
        {parentId && childId ? <button type="button" className="mf-flow-open" onClick={() => openStep(parentId, childId)}>{ui('Open')}</button> : undefined}
      </>}>
      {open ? <div className="mf-flow-body" data-report={parts.open || undefined}><MarkdownText text={body} labels={labels} /></div> : undefined}
    </DisclosureRow>
    {activity ? <div className="mf-flow-activity" title={activity}>{activity}</div> : undefined}
  </div>;
}
