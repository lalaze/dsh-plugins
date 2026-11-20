/** Shared by the host half and the client: the route, what a status says, and what the tab is told. */

export const ROUTE = '/api/project-status';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Project-Status';
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;

/** What is written down about one goal, besides its name and its steps. */
export const PARTS = ['progress', 'blockers', 'next'] as const;
export type Part = typeof PARTS[number];
/**
 * One of the things the project is working towards, with a status of its own: a project has several going at once, each
 * at another point and stuck on something else.
 */
export interface Goal {
  title: string;
  done: boolean;
  /** What it breaks down into: a Markdown task list (see goals.ts). */
  steps: string;
  progress: string;
  blockers: string;
  next: string;
}
/** Characters one text may hold; a status is a few lines, not a document. */
export const FIELD_LIMIT = 8000;
export const TITLE_LIMIT = 300;
/** More goals than this in one project is a backlog, which belongs in a tracker. */
export const GOAL_LIMIT = 100;
/** A status file larger than this was not written as one; it is refused rather than loaded into every poll. */
export const FILE_LIMIT = 256 * 1024;
/** The revision of a status nobody has written yet. */
export const NO_REVISION = 'none';

/** A project: a Git repository with all of its worktrees and branches, or a folder that is in none. */
export interface ProjectInfo {
  /** Names its status file; the same for every checkout of the repository on this machine. */
  id: string;
  name: string;
  /** The main checkout, or the folder itself outside Git. */
  root: string;
  git: boolean;
  /** The machine's label when the project is on another machine; absent on this computer. */
  machine?: string;
}

/** What Git knows without anyone writing it down. Counts are of the conversation's folder unless said otherwise. */
export interface Facts {
  /** Absent before the first commit or on a detached HEAD. */
  branch?: string;
  /** Changed and untracked files. */
  dirty: number;
  /** Commits on HEAD that no remote has; null when the repository has no remote to push to. */
  unpushed: number | null;
  /** Checkouts of the project besides the main one. */
  worktrees: number;
  stashes: number;
  /** Milliseconds; absent before the first commit. */
  lastCommit?: number;
}

/** Conversations in the project's checkouts. */
export interface Conversations { count: number; lastActive?: number }

export interface StatusAnswer {
  project: ProjectInfo;
  /** What the project as a whole is for. */
  aim: string;
  goals: Goal[];
  /** Whether the file has sections besides these; they are kept when the tab saves. */
  more: boolean;
  /** Of the file's text; a save names the one it started from. */
  revision: string;
  /** When the file was last written, in milliseconds; absent when there is none yet. */
  updatedAt?: number;
  /** Where the status is kept, when an agent working in this conversation's folder can open it: on this computer only. */
  file?: string;
  facts?: Facts;
  /** Why there are no facts, when the project is in Git and Git could not be asked. */
  factsError?: string;
  conversations?: Conversations;
}

/** A status as the `projectStatus` service lists it for other plugins. */
export interface ProjectStatusEntry { project: ProjectInfo; aim: string; goals: Goal[]; updatedAt?: number }

/** Which goal a change is for: by its name, and which one of that name when several share it. */
export interface GoalRef { title: string; nth?: number }
/**
 * One change to a status. A text names what it replaces (`was`), so that a text someone else wrote meanwhile is not
 * overwritten; the rest say what should be so, and can be repeated.
 */
export type Change =
  | { op: 'aim'; value: string; was: string }
  | { op: 'part'; goal: GoalRef; part: Part | 'steps'; value: string; was: string }
  | { op: 'title'; goal: GoalRef; value: string }
  | { op: 'done'; goal: GoalRef; value: boolean }
  | { op: 'add'; title: string }
  | { op: 'remove'; goal: GoalRef };
