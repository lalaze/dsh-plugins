import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('dsh-claude-ssh/package.json'));
const root = resolve('.');
const destination = join(root, 'lib/claude');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// Preserve module-relative worker URLs (keeper.js) and all route implementations.
await cp(join(source, 'lib/server'), join(destination, 'server'), { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.md', 'CHANGELOG.md']) await cp(join(source, file), join(destination, file));
// Native status/update routes must describe the package that is actually installed.
await cp(join(root, 'package.json'), join(destination, 'package.json'));
await cp(join(source, 'locale'), join(root, 'locale'), { recursive: true });
for (const name of await readdir(join(root, 'lib/server'))) {
  if (!/\.(?:js|d\.ts)$/.test(name)) continue;
  const path = join(root, 'lib/server', name);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/(['"])dsh-claude-ssh(?:\/process)?\1/g, match => `${match[0]}../claude/server/${match.includes('/process') ? 'process' : 'adapter'}.js${match[0]}`));
}
