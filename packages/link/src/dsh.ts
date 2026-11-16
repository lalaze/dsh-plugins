/**
 * The slice of the DSH 0.2.2 Host API this plugin uses, typed locally: the real declarations live in
 * packages whose type graphs pull in most of DSH. Shapes follow `@deepseek-ai/dsh-host-webserver` and
 * `@deepseek-ai/dsh-client-connection` of 0.2.2-rc.3.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface WebRoute {
  kind: 'exact' | 'prefix';
  /** Absolute pathname, no trailing slash. A prefix route matches the path and everything below it. */
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface WebUpgradeRoute {
  /** Exact pathname: the webServer has no prefix upgrade routes. */
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

export interface WebServer {
  /** Undefined until the server listens. */
  readonly port: number | undefined;
  register(route: WebRoute): () => void;
  registerUpgrade(route: WebUpgradeRoute): () => void;
}

export interface HostConnection {
  /** 403 for an untrusted Host/Origin, 401 when unauthenticated, otherwise undefined. */
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined;
  /** `baseUrl` with this process's login token attached. */
  authenticatedUrl(baseUrl: string): string;
}

export interface SessionLike { readonly id: string }
export interface SessionEvent { type: string; seq: number; time: number; data: unknown }

export interface AgentLike {
  readonly id: string;
  readonly status: string;
  readonly session?: SessionLike;
  readonly inbox?: { readonly nextTurn?: readonly unknown[]; readonly nextStep?: readonly unknown[] };
}
export interface JobLike { readonly id: string; readonly label?: string; readonly owner?: string; readonly status: string }

export interface OptionalServices {
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
  sessionTitle: { get(session: SessionLike): { readonly title: string } | undefined };
  /** Loaded Sessions by id; `sessionTitle` needs the real Session, not just its id. */
  sessions: { get?(id: string): SessionLike | undefined };
  agents: { list(): readonly AgentLike[] };
  jobs: { list(owner?: string): readonly JobLike[] };
  profileContext: { readonly name: string; readonly dir: string };
}

export interface HostEvents {
  'session/event': (session: SessionLike, event: SessionEvent) => void;
  'session/disposed': (session: SessionLike) => void;
  /** A conversation started or stopped running: DSH's own agents, and remote-terminals' TUI conversations. */
  'api-session/status': (sessionId: string, running: boolean) => void;
}

export interface HostContext {
  readonly logger?: OptionalServices['logger'];
  readonly webServer: WebServer;
  readonly connection: HostConnection;
  effect(factory: () => () => void | Promise<void>, label?: string): void;
  get<K extends keyof OptionalServices>(name: K): OptionalServices[K] | undefined;
  on<K extends keyof HostEvents>(event: K, listener: HostEvents[K], options?: { global?: boolean }): () => void;
}
