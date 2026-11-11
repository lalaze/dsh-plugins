/** What must hold before a fix is committed: nothing sensitive in it, and which packages it touched. */
import { say, type Message, type Route } from './domain.js';

const SENSITIVE_PATHS: readonly RegExp[] = [/(^|\/)\.env(\.|$)/u, /(^|\/)\.npmrc$/u, /(^|\/)id_rsa$/u, /(^|\/)id_ed25519$/u, /(^|\/)secrets?(\.|\/|$)/iu];
const SECRETS: readonly RegExp[] = [/token\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/iu, /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/iu, /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u];

/** `git status --porcelain=v1 -z` as paths; a rename counts as its new path. */
export function changedFiles(porcelain: string): string[] {
  const entries = porcelain.split('\0').filter(Boolean), files: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], code = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) index++;
  }
  return files;
}
/** Why this fix may not be committed at all, or undefined. */
export function blocked(files: readonly string[], addedLines: string): Message | undefined {
  if (!files.length) return say('The models left no change.');
  for (const file of files) {
    const path = file.replace(/\\/gu, '/');
    if (path.startsWith('../') || path.includes('/../')) return say('A changed file is outside the worktree: {file}', { file });
    if (SENSITIVE_PATHS.some(pattern => pattern.test(path))) return say('A sensitive file was changed: {file}', { file });
  }
  return SECRETS.some(pattern => pattern.test(addedLines)) ? say('The change looks like it contains a secret (a token, an API key or a private key).') : undefined;
}
/** The lines a diff adds, without its headers. */
export const addedLines = (diff: string) => diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');

const under = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);
// The package folder a file belongs to under a glob such as packages/* (a star stands for one folder name).
function packageOf(file: string, glob: string): string | undefined {
  const parts = glob.split('/'), names = file.split('/');
  if (names.length <= parts.length) return undefined;
  for (let index = 0; index < parts.length; index++) if (parts[index] !== '*' && parts[index] !== names[index]) return undefined;
  return names.slice(0, parts.length).join('/');
}
export interface Touched { packages: string[]; shared: string[]; other: string[] }
/** A fix's files sorted by where they are: business packages, the shared paths, and everything else. */
export function touched(files: readonly string[], route: Pick<Route, 'packageGlobs' | 'sharedPaths'>): Touched {
  const packages = new Set<string>(), shared: string[] = [], other: string[] = [];
  for (const raw of files) {
    const file = raw.replace(/\\/gu, '/');
    if (route.sharedPaths.some(path => under(file, path))) { shared.push(file); continue; }
    const owner = route.packageGlobs.map(glob => packageOf(file, glob)).find(Boolean);
    if (owner) packages.add(owner); else other.push(file);
  }
  return { packages: [...packages].sort(), shared, other };
}
/** What a person should look at before accepting. None of it stops a task. */
export function warnings(found: Touched, route: Pick<Route, 'packageGlobs'>, hint?: string): Message[] {
  if (!route.packageGlobs.length) return [];
  const notes: Message[] = [];
  if (found.packages.length > 1) notes.push(say('The fix touches {count} packages: {packages}', { count: String(found.packages.length), packages: found.packages.join(', ') }));
  if (hint && found.packages.length && !found.packages.includes(hint)) notes.push(say('The fix is in {packages}, not in {hint} as chosen', { packages: found.packages.join(', '), hint }));
  if (found.other.length) notes.push(say('Changed outside the packages and shared paths: {files}', { files: `${found.other.slice(0, 5).join(', ')}${found.other.length > 5 ? ` (+${found.other.length - 5})` : ''}` }));
  if (!found.packages.length && !hint) notes.push(say('Only shared files changed and no package was chosen, so no package was built'));
  return notes;
}
/** The first script of `priority` a package.json has. */
export function chooseScript(packageJson: string | undefined, priority: readonly string[]): string | undefined {
  if (!packageJson) return undefined;
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return priority.find(name => typeof scripts[name] === 'string');
  } catch { return undefined; }
}
const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
/**
 * The commands to run: a template naming `{package}` or `{script}` once per package, the rest once. A package without
 * any of the build scripts skips the templates that need `{script}`, and says so.
 */
export function commands(templates: readonly string[], packages: readonly { path: string; script?: string }[]): { run: string[]; skipped: Message[] } {
  const run: string[] = [], skipped: Message[] = [];
  for (const template of templates) {
    if (!/\{(?:package|script)\}/u.test(template)) { run.push(template); continue; }
    for (const entry of packages) {
      if (template.includes('{script}') && !entry.script) { skipped.push(say('{package} has none of the build scripts, so "{command}" was not run for it', { package: entry.path, command: template })); continue; }
      run.push(template.replaceAll('{package}', quote(entry.path)).replaceAll('{script}', quote(entry.script ?? '')));
    }
  }
  return { run: [...new Set(run)], skipped };
}
