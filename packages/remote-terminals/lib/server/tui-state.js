/** What names a TUI conversation on its machine, the same in every DSH that shows it. */
export const tuiKey = (sessionId, details) => details?.key || sessionId;
