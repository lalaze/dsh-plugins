/** Shared, browser-safe workspace contracts. Paths are relative to a verified workspace. */
/** The launcher's file name, which DSH's terminal shell menu shows as the item label. */
export const TERMINAL_LAUNCHER = 'Remote workspace';
/** Beside it in the same directory: the same terminal, starting Claude Code or Codex. */
export const CLAUDE_LAUNCHER = 'Remote Claude', CODEX_LAUNCHER = 'Remote Codex';
export const TUI_LAUNCHERS = { claude: CLAUDE_LAUNCHER, codex: CODEX_LAUNCHER };
export const GIT_LIMITS = { commands: 16, arguments: 64, bytes: 64 * 1024, output: 16 * 1024 * 1024, timeoutMs: 170_000, totalMs: 280_000 };
export const FILE_LIMIT = 50 * 1024 * 1024;
export const TEXT_LIMIT = 256 * 1024;
