import { busy, type AgentSummary } from '../domain.js';

export type SessionView = 'active' | 'history' | 'archived';
export const needsAttention = (agent: AgentSummary) => agent.pendingPermissions > 0 || agent.status === 'attention' || agent.status === 'error';
export function sessionView(agent: AgentSummary): SessionView {
  return agent.archived ? 'archived' : busy(agent) || needsAttention(agent) ? 'active' : 'history';
}
export const visibleSession = (agent: AgentSummary) => !agent.chatSessionId?.startsWith('remote-compaction-');
export function sessionPriority(a: AgentSummary, b: AgentSummary): number {
  return Number(needsAttention(b)) - Number(needsAttention(a))
    || Number(busy(b)) - Number(busy(a)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}
export const projectName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
