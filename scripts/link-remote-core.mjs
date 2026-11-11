// A plugin's server build compiles @dsh-plugins/remote-core into its own lib/server/core. This turns the package
// imports tsc left in lib/server into relative ones, so the installed plugin needs no shared package.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Package scripts run in their own directory, including through pnpm --filter.
const root = resolve(process.cwd(), 'lib/server'), core = join(root, 'core');
const specifier = /(['"])@dsh-plugins\/remote-core\/([\w-]+\.js)\1/g;

let linked = 0;
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(js|d\.ts)$/.test(entry.name)) continue;
  const file = join(entry.parentPath, entry.name), source = await readFile(file, 'utf8');
  const result = source.replace(specifier, (_, quote, name) => {
    if (!existsSync(join(core, name))) throw new Error(`${file} imports @dsh-plugins/remote-core/${name}, which the build did not write to ${core}`);
    const path = relative(dirname(file), join(core, name)).split(sep).join('/');
    linked++;
    return `${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`;
  });
  // Another spelling of the import, such as a file without .js, would fail only once installed.
  if (/['"]@dsh-plugins\/remote-core/.test(result)) throw new Error(`${file} still imports @dsh-plugins/remote-core after linking`);
  // tsc may spell an inferred type's module as a path from the source file to the compiled core.
  if (/['"][./]*\/lib\/server\//.test(result)) throw new Error(`${file} imports through lib/server, which does not exist beside it once installed`);
  if (result !== source) await writeFile(file, result);
}
if (!linked) throw new Error(`No @dsh-plugins/remote-core import found under ${root}; drop this step from the build`);
