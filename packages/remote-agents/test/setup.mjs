// Loaded before each test file and by the runner they inherit their environment from: `pnpm test` passes it with --import.

// Node then prints an experimental warning on stderr of every process, and tests read the stderr of the ones they start.
delete process.env.NODE_USE_ENV_PROXY;
// macOS's per-user temporary folder is long enough to put test sockets over its 104-byte limit for Unix socket paths.
if (process.platform === 'darwin') process.env.TMPDIR = '/tmp';
