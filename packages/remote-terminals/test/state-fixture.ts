import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { TerminalsState } from '../src/state.js';

/** The plugin's saved state in a folder of its own, removed with the test. */
export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-terminals-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TerminalsState(join(directory, 'state.json'));
  await store.open();
  return { directory, store, path: store.file };
}
