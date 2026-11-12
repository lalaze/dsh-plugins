/** What the plugin keeps: settings, the bugs waiting to be handed out, and the tasks working on them. */
import type { FlowEnd, FlowRole, FlowStep, ModelChoice, Permission } from './conversations.js';

/**
 * A bug as any source hands it in. `source` and `id` name it for good; the rest is what a person and a model read.
 * `ref` is the short name people use for it (a TAPD bug number); `project` is where it lives in the source's own terms.
 */
export interface Item {
  source: string; id: string; ref: string; title: string;
  /** Plain text. Pictures the source could not put into words stand as `[image N]`. */
  body: string;
  url?: string;
  project?: { id: string; name: string };
  status?: string; priority?: string; module?: string;
  labels: string[];
  /** How many pictures the bug has. The body may place them as `[image N]`; the source hands each over through `image`. */
  images?: number;
  /** Absent for a bug. A feature is something to build, handed in by /flow: the same road, other words. */
  kind?: 'feature';
}
/** One picture of a bug, as the source read it. */
export interface ItemImage { data: Uint8Array; mediaType: string; name?: string }
export const itemKey = (item: { source: string; id: string }) => `${item.source}:${item.id}`;

/** What happened to an item, told to its source so it can write back to wherever the item came from. */
export type ItemEvent =
  | { kind: 'started'; baseBranch: string }
  | { kind: 'review'; branch: string; commit: string; checks: number }
  | { kind: 'accepted'; baseBranch: string; branch: string; commit: string; mergeCommit?: string };
/**
 * Where bugs come from: an issue tracker that is asked (`fetch`), or anything that hands bugs in when it has them
 * (`Autofix.submit`). A source registers with the service `autofix` and keeps its own sign-in and settings.
 */
export interface Source {
  /** Short and stable: part of every item's key, branch and commit message, as `tapd`. */
  id: string;
  /** What people call it. */
  name: string;
  /** Why it cannot be used yet, in words for a person; undefined when it is set up. */
  unready?(): Message | undefined;
  /** Everything open right now. An item it no longer lists is shown as no longer the person's. */
  fetch?(signal?: AbortSignal): Promise<Item[]>;
  /** A rejection is kept on the task and can be tried again; it never undoes what happened in Git. */
  report?(item: Item, event: ItemEvent): Promise<void>;
  /** Picture `index` (from 0) of an item, for the models to look at; undefined when it cannot be had. */
  image?(item: Item, index: number, signal?: AbortSignal): Promise<ItemImage | undefined>;
  /** The item is gone for good (fixed, or thrown away): whatever the source kept for it can go. */
  discard?(item: Item): Promise<void>;
}
/** The service `autofix`, for plugins that are sources. */
export interface Autofix {
  readonly version: 1;
  /** Returns how to take the source away again. Registering an ID again replaces the earlier one. */
  register(source: Source): () => void;
  /** For a source that is not asked: these bugs are open now. Known ones are refreshed; none is marked stale. */
  submit(sourceId: string, items: readonly Item[]): Promise<{ added: number }>;
  /**
   * For /flow, since 0.1.4: what a person typed in a conversation becomes a task in the repository that conversation works
   * in, as a typed /fix does. `agent` is the conversation's live agent; `kind: 'feature'` is something to build rather
   * than a bug; `models` and `rounds` are for this task alone. Answers the row to leave in the conversation.
   */
  file(input: { agent: unknown; text: string; attachments?: readonly unknown[]; kind?: 'feature'; repo?: string; branch?: string; models?: Partial<Record<FlowRole, string>>; rounds?: number }): Promise<{ kind: 'success' | 'error'; text: string }>;
}
export const SOURCE_ID = /^[a-z][a-z0-9-]{0,30}$/u;

/** A repository bugs can be sent to. `project` is the DSH workspace that stands for it, on this computer or a saved machine. */
export interface Route {
  id: string; name: string; project: string;
  defaultBranch: string;
  /** Run after the models finish, before anything is committed. `{package}` and `{script}` stand for each package the fix touched. */
  tests: string[];
  // A monorepo's package folders, written with a star for the package name (packages/*); empty for a repository that is one project.
  packageGlobs: string[];
  /** Folders any fix may touch without counting as another package. */
  sharedPaths: string[];
  /** The first of these scripts a package has is its `{script}`. */
  buildScripts: string[];
  /** A command that serves the fix on `$PORT`; `{package}` as in `tests`. */
  preview: string;
  pushRemote: string;
  /** What accepting does: merge into the base branch and push it, or only push the task's branch. */
  accept: 'merge' | 'push-branch';
}
export interface RunSettings {
  /** Bugs carrying one of these labels are never started. */
  denyLabels: string[];
  /** The task conversation's own model; the flow's steps use the models chosen for /flow unless `flowModels` names others. */
  model?: ModelChoice;
  permission: Permission;
  rounds: number;
  flowModels: Partial<Record<FlowRole, string>>;
  /** How many times a failed check sends the work back to the models before the task fails. */
  checkRetries: number;
  /** Whether other DSHes may hand bugs to this one, through the machines that hold its repositories. */
  relay: boolean;
}
export interface Settings { routes: Route[]; run: RunSettings }

export const SENSITIVE_LABELS = ['security', 'payment', 'auth', 'migration', 'prod-incident'];
export const defaultSettings = (): Settings => ({
  routes: [],
  run: { denyLabels: [...SENSITIVE_LABELS], permission: 'workspace-write', rounds: 3, flowModels: {}, checkRetries: 1, relay: false },
});

export interface Assignment { routeId: string; branch: string; package?: string }
export interface PoolItem {
  key: string; item: Item;
  firstSeen: number; lastSeen: number;
  /** No longer among the source's open bugs at its last fetch. */
  stale?: boolean;
  dismissed?: boolean;
  assignment?: Assignment;
}

/** Something to tell a person: English with `{name}` places, so a page can say it in its own language; `detail` is raw output. */
export interface Message { key: string; values?: Record<string, string>; detail?: string }
export const say = (key: string, values?: Record<string, string>, detail?: string): Message => ({ key, ...(values ? { values } : {}), ...(detail ? { detail } : {}) });
export const render = (message: Message): string => message.key.replace(/\{(\w+)\}/gu, (whole, name: string) => message.values?.[name] ?? whole) + (message.detail ? `\n${message.detail}` : '');
/** An error that knows how to be said in another language. */
export class Failure extends Error {
  constructor(readonly said: Message) { super(render(said)); }
}
export const fail = (key: string, values?: Record<string, string>, detail?: string) => new Failure(say(key, values, detail));
export const messageOf = (error: unknown): Message => error instanceof Failure ? error.said : say(error instanceof Error ? error.message : String(error));

export type TaskStatus =
  | 'preparing'   // worktree and conversation
  | 'working'     // the models
  | 'checking'    // diff rules and test commands
  | 'review'      // committed locally, waiting for the person
  | 'accepting'   // merge, push, TAPD
  | 'done'
  | 'failed'
  | 'stopped';
export const ACTIVE: readonly TaskStatus[] = ['preparing', 'working', 'checking', 'accepting'];
export interface CheckRun { command: string; code: number | null; ms: number; tail: string }
export interface TaskCheck {
  files: string[];
  /** Business packages the fix touched, as their folders. */
  packages: string[];
  /** Things to look at before accepting; none of them stopped the task. */
  warnings: Message[];
  runs: CheckRun[];
}
export interface TaskEvent { at: number; said: Message }
export interface Task {
  key: string; item: Item; routeId: string; baseBranch: string; packageHint?: string;
  status: TaskStatus;
  /** Flows run so far, the first included. */
  attempts: number;
  branch?: string; worktree?: string; workspacePath?: string; sessionId?: string;
  /** The bug's pictures the models are given, as DSH keeps them: `index` is the picture's place in the bug, from 0. */
  pictures?: { index: number; ref: unknown }[];
  /**
   * The newest flow: its steps as they are now, and how it ended once it has. `rounds`, `planned` and `zh` are what its
   * card is drawn with; `startedAt` is when it began, and `carded` that its card in the conversation carries the task.
   */
  flow?: { steps: FlowStep[]; end?: FlowEnd; report?: string; rounds?: number; planned?: boolean; zh?: boolean; startedAt?: number; carded?: boolean };
  /** What /flow asked for this task alone: other models for its steps, another number of review rounds. */
  models?: Partial<Record<FlowRole, string>>;
  rounds?: number;
  check?: TaskCheck;
  commit?: string; mergeCommit?: string;
  error?: Message;
  /** What the person said when sending it back. */
  feedback?: string;
  /** How many cards the task has put into its conversation; only the newest one can be acted on. */
  cards?: number;
  /** What the source could not be told after the Git side succeeded; the task can tell it again. */
  reportPending?: ItemEvent;
  startedAt: number; updatedAt: number;
  events: TaskEvent[];
}

const str = (value: unknown, what: string, max = 2000): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${what} must be text of at most ${max} characters`);
  return value.trim();
};
const list = (value: unknown, what: string, max = 100): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${what} must be a list of at most ${max} entries`);
  return [...new Set(value.map(entry => str(entry, what)).filter(Boolean))];
};
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is missing`);
  return value as Record<string, unknown>;
};
const whole = (value: unknown, what: string, min: number, max: number, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  return value;
};
/** A path inside a repository: relative, forward slashes, no way out. */
const repoPath = (value: string, what: string): string => {
  const path = value.replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw fail(`${what} must be a path inside the repository`);
  return path;
};
const PERMISSIONS: readonly Permission[] = ['workspace-write', 'auto', 'danger-full-access'];

/** Settings as a person typed them, checked; throws what to fix. */
export function settingsFrom(raw: unknown): Settings {
  const input = record(raw, 'Settings'), base = defaultSettings();
  const ids = new Set<string>();
  const routes = (Array.isArray(input.routes) ? input.routes : []).slice(0, 100).map((entry, index) => {
    const route = record(entry, `Repository ${index + 1}`), name = str(route.name, 'Repository name', 100), id = str(route.id ?? '', 'Repository ID', 100) || name;
    if (!name) throw fail('Repository {index} needs a name', { index: String(index + 1) });
    if (ids.has(id)) throw fail('Two repositories are called {name}', { name: id });
    ids.add(id);
    const project = str(route.project, 'Project', 4096);
    if (!project) throw fail('{name}: choose the project it lives in', { name });
    return {
      id, name, project,
      defaultBranch: str(route.defaultBranch ?? '', 'Default branch', 200),
      tests: list(route.tests, 'Test commands', 20),
      packageGlobs: list(route.packageGlobs, 'Package folders', 20).map(glob => repoPath(glob, 'A package folder')),
      sharedPaths: list(route.sharedPaths, 'Shared paths', 50).map(path => repoPath(path, 'A shared path')),
      buildScripts: list(route.buildScripts, 'Build scripts', 10),
      preview: str(route.preview ?? '', 'Preview command'),
      pushRemote: str(route.pushRemote ?? '', 'Remote', 100) || 'origin',
      accept: route.accept === 'push-branch' ? 'push-branch' as const : 'merge' as const,
    };
  });
  const run = record(input.run ?? {}, 'Run settings'), model = run.model === undefined || run.model === null ? undefined : record(run.model, 'Model');
  const flowModels = record(run.flowModels ?? {}, 'Flow models');
  return {
    routes,
    run: {
      denyLabels: list(run.denyLabels ?? base.run.denyLabels, 'Labels to skip', 50),
      ...(model ? { model: { provider: str(model.provider, 'Model provider', 200), model: str(model.model, 'Model', 500), ...(model.reasoningEffort ? { reasoningEffort: str(model.reasoningEffort, 'Thinking level', 50) } : {}) } } : {}),
      permission: PERMISSIONS.find(value => value === run.permission) ?? base.run.permission,
      rounds: whole(run.rounds, 'Review rounds', 1, 5, base.run.rounds),
      flowModels: Object.fromEntries((['plan', 'implement', 'review'] as const).flatMap(role => typeof flowModels[role] === 'string' && (flowModels[role] as string).trim() ? [[role, str(flowModels[role], 'A flow model', 300)]] : [])),
      checkRetries: whole(run.checkRetries, 'Check retries', 0, 5, base.run.checkRetries),
      relay: run.relay === true,
    },
  };
}

/** An item as a source plugin handed it over, checked: another plugin's data is not trusted to have the right shape. */
export function itemFrom(raw: unknown, source: string): Item {
  const input = record(raw, 'A bug'), id = str(input.id, 'A bug\'s ID', 200), title = str(input.title, 'A bug\'s title', 500);
  if (!id || !title) throw new Error('A bug needs an ID and a title');
  const text = (value: unknown, what: string, max: number) => value === undefined || value === null ? '' : str(value, what, max);
  const project = input.project && typeof input.project === 'object' ? record(input.project, 'A bug\'s project') : undefined;
  const url = text(input.url, 'A bug\'s link', 2000), status = text(input.status, 'A bug\'s status', 100), priority = text(input.priority, 'A bug\'s priority', 100), module = text(input.module, 'A bug\'s module', 200);
  const images = typeof input.images === 'number' && Number.isSafeInteger(input.images) && input.images > 0 ? Math.min(input.images, 100) : 0;
  return {
    source, id, ref: text(input.ref, 'A bug\'s short name', 100) || id, title,
    body: typeof input.body === 'string' ? input.body.slice(0, 200_000) : '',
    ...(/^https?:\/\//u.test(url) ? { url } : {}),
    ...(project && str(String(project.id ?? ''), 'A project ID', 200) ? { project: { id: str(String(project.id), 'A project ID', 200), name: text(project.name, 'A project name', 200) || String(project.id) } } : {}),
    ...(status ? { status } : {}), ...(priority ? { priority } : {}), ...(module ? { module } : {}),
    labels: list(input.labels, 'A bug\'s labels', 50),
    ...(images ? { images } : {}),
    ...(input.kind === 'feature' ? { kind: 'feature' as const } : {}),
  };
}
