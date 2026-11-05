import type { AgentSummary, Cursor, Permission, PermissionAnswer, TimelinePage } from '../core/domain.js';
import type { RemoteAgentsService } from './service.js';

/** A remote CLI session with no conversation in this DSH, and the machine it runs on. */
export interface RemoteTask extends AgentSummary { host: string }
export interface RemoteTaskDetail { task: RemoteTask; permissions: Permission[]; timeline: TimelinePage | null }

/**
 * Remote CLI sessions that have no conversation in this DSH, for other plugins on this host such as dsh-mobile, as the
 * service `remoteAgentsTasks`: tasks DSH's agent delegated and sessions started from Open sessions. Conversations bound
 * to a main chat are left out; they are DSH sessions of their own.
 */
export interface RemoteAgentsTasks {
  /** Version 1: list, read, send, stop and answer approvals. */
  readonly tasksVersion: 1;
  list(): Promise<RemoteTask[]>;
  /** One page of the task's history, newest first by default, with its status and the approvals it waits for. */
  detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<RemoteTaskDetail>;
  /** `messageId` makes a retried send arrive once. A working task is interrupted first, as in Paseo. */
  send(id: string, messageId: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void>;
  /** Called after a task is added, changed or removed. Progress within a turn is read with `detail`. */
  subscribe(listener: () => void): () => void;
  /** What marks a DSH conversation as read as far as it goes, on any DSH or phone; see `RemoteAgentsService.chatReadMark`. */
  chatReadMark(sessionId: string): string | undefined;
  /** The user read a DSH conversation here: tell the others sharing it. */
  markChatRead(sessionId: string): Promise<void>;
  /** Called with a DSH conversation when how far it has been read changes. */
  subscribeChatRead(listener: (sessionId: string) => void): () => void;
}

export function remoteTasks(service: RemoteAgentsService): RemoteAgentsTasks {
  const unbound = (task: RemoteTask | AgentSummary) => !task.chatSessionId;
  const withHost = (agent: AgentSummary): RemoteTask => ({ ...agent, host: service.hosts().find(h => h.id === agent.hostId)?.label ?? agent.hostId });
  const task = async (id: string) => {
    const agent = await service.summary(id);
    if (!unbound(agent)) throw new Error('This session continues in a DSH conversation; open it there');
    return agent;
  };
  return {
    tasksVersion: 1,
    list: async () => (await service.snapshot()).agents.filter(unbound).map(withHost),
    detail: async (id, cursor, direction) => {
      await task(id);
      const { agent, permissions, timeline } = await service.detail(id, cursor, direction);
      return { task: withHost(agent), permissions, timeline };
    },
    send: async (id, messageId, text) => { await task(id); await service.send(id, { id: messageId, text }); },
    stop: async id => { await task(id); await service.stop(id); },
    respond: async (id, requestId, answer) => { await task(id); await service.respond(id, requestId, answer); },
    subscribe: listener => {
      service.store.changeListeners.add(listener);
      return () => { service.store.changeListeners.delete(listener); };
    },
    chatReadMark: sessionId => service.chatReadMark(sessionId),
    markChatRead: sessionId => service.markChatRead(sessionId),
    subscribeChatRead: listener => {
      service.chatReadListeners.add(listener);
      return () => { service.chatReadListeners.delete(listener); };
    },
  };
}
