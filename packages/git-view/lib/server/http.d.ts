import type { GitView } from './git.js';
/** `POST /api/git-view` with `{ action, sessionId, ... }`. Every action works on the conversation's own workspace. */
export declare function createHandler(git: GitView, log?: (message: string) => void): (request: Request) => Promise<Response>;
