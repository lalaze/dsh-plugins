import { type ChatProject, type Choice } from '../core/domain.js';
import type { RemoteAgentsService } from '../agents/service.js';
/** Saved, explicitly discovered catalogs let the native model picker work without opening SSH. */
export declare class ChatProjects {
    readonly service: RemoteAgentsService;
    private listeners;
    private effortListeners;
    constructor(service: RemoteAgentsService);
    list(): ChatProject[];
    /** The picker advertises one catalog per host; old project routes remain resolvable for saved chats. */
    hosts(): ChatProject[];
    routes(): ChatProject[];
    onChange(listener: () => void): () => void;
    private changed;
    /** Only explicit effort selections change a model's advertised default. */
    onEffortChange(listener: () => void): () => void;
    /** Validate and remember a successful picker selection without SSH or starting a CLI. */
    setEffort(provider: string, route: string, effort: string): Promise<void>;
    /** The Fast tier a native chat model route offers; a route saved with a tier names the same model. */
    fastTier(route: string): Choice | undefined;
    /** Whether a conversation's model offers Fast, and whether the conversation has it on. */
    speed(sessionId: string, route: string): {
        available: boolean;
        enabled: boolean;
    };
    /** Turn Fast on or off for a conversation's next turns; a turn already running keeps its speed. */
    setFast(sessionId: string, enabled: boolean): Promise<{
        enabled: boolean;
    }>;
    add(input: unknown): Promise<ChatProject[]>;
    refresh(id: string): Promise<ChatProject[]>;
    remove(id: string): Promise<ChatProject[]>;
}
