import { type Permission, type PermissionAnswer } from '../core/domain.js';
import type { RemoteAgentsService } from './service.js';
import type { ToolCall, ToolDefinition, ToolHost } from '../core/dsh-host.js';
export interface AgentReport {
    id: string;
    title: string;
    host: string;
    cwd: string;
    provider: string;
    model: string;
    mode?: string;
    status: string;
    error?: string;
    waitingFor?: string[];
    reply?: string;
}
export interface WaitResult {
    agents: AgentReport[];
    timedOut: boolean;
}
export declare function decidePermission(host: ToolHost, permission: Permission, exec: ToolCall, signal: AbortSignal, subject: string): Promise<PermissionAnswer | undefined>;
/**
 * Paseo-style delegation for the DSH agent: start remote CLI agents, message them and collect their
 * replies. Permission requests are forwarded to the user as native DSH prompts while a call waits;
 * unanswered requests remain pending and can be shown again by another wait.
 */
export declare function delegationTools(host: ToolHost, service: RemoteAgentsService): ToolDefinition[];
