/** Shared by the host half and the client: the route, the four things a status says, and what the tab is told. */

export const ROUTE = '/api/project-status';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Project-Status';
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;

/** What a status says, in the order the file and the tab show it. */
export const FIELDS = ['goal', 'progress', 'blockers', 'next'] as const;
export type Field = typeof FIELDS[number];
export type Fields = Record<Field, string>;
/** Characters one of them may hold; a status is a few lines, not a document. */
export const FIELD_LIMIT = 8000;
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
  fields: Fields;
  /** Whether the file has sections besides the four; they are kept when the tab saves. */
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
export interface ProjectStatusEntry { project: ProjectInfo; fields: Fields; updatedAt?: number }
