/**
 * The image source a project's agents generate with. The project gets `.game-assets/` (the source without its key, the
 * generate-image script and a README) and a short section in AGENTS.md and CLAUDE.md; a key, when the source needs one,
 * goes to `~/.dsh-game-assets/keys.json` on the machine the project is on, readable by the user alone, never into the
 * project. Runs where the workspace is: in the host for a local workspace, in the remote script for a remote one.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AGENT_FILES, KEYS_DIR, KEYS_FILE, PROJECT_DIR, PROJECT_README, PROJECT_SCRIPT, PROJECT_SOURCE_FILE, SOURCE_KINDS, usesApi, type ProjectSource, type ProjectSourceStatus, type SourceKind } from './domain.js';

/** What recording a source carries to the workspace's machine: the source, the script, and its key if it has one. */
export interface ProjectBundle { source: ProjectSource; script: string; key?: string }

const BEGIN = '<!-- dsh-game-assets:image-source -->', END = '<!-- /dsh-game-assets:image-source -->';
const BLOCK = /\n*<!-- dsh-game-assets:image-source -->[\s\S]*?<!-- \/dsh-game-assets:image-source -->\n?/;
const KIND_NAME: Record<SourceKind, string> = { openai: 'an OpenAI-compatible image API', gemini: 'the Gemini API', codex: 'the Codex CLI signed in on this machine' };
const COMMAND = `node ${PROJECT_SCRIPT} --prompt "a blue slime, pixel art" --out assets/slime.png`;

const describe = (source: ProjectSource) => `"${source.name}" (${KIND_NAME[source.kind]}${source.model ? `, model ${source.model}` : ''})`;

/** The section agent instruction files get. */
export function agentSection(source: ProjectSource): string {
  return `${BEGIN}
## Generating images

This project generates images with the image source ${describe(source)}, chosen in DSH's Assets tab. From the project root:

    ${COMMAND}

Add \`--ref <image>\` (up to four) to draw from existing images, \`--shape square|wide|tall\` and \`--transparent\`. It writes one picture at the size the source makes and never overwrites a file; resize it yourself if the game needs another size. It prints the saved path and pixel size as JSON. More in \`${PROJECT_README}\`.
${END}
`;
}

/** The README next to the script. */
export function projectReadme(source: ProjectSource): string {
  return `# Image generation for agents

Written by DSH Game Assets. This project generates images with ${describe(source)}. The source is chosen in DSH's Assets tab, in the generate dialog; choose another there to change it.

## Usage

Run from the project root (or anywhere, with the path to the script):

\`\`\`sh
${COMMAND}
node ${PROJECT_SCRIPT} --prompt "redraw this sprite as a winter version" --ref assets/hero.png --out assets/hero-winter.png --transparent
\`\`\`

| Option | Meaning |
| --- | --- |
| \`--prompt <text>\` | What to draw (required). \`--prompt-file <file>\` reads it from a file. |
| \`--out <path>\` | Where to save, inside the project: \`.png\`, \`.webp\` or \`.jpg\` (required). An existing file is never replaced. |
| \`--ref <image>\` | A PNG, WebP or JPEG to draw from; repeat for up to four. |
| \`--shape square\\|wide\\|tall\` | The shape asked for (default square). |
| \`--transparent\` | Ask for a transparent background (not with Gemini). |

The picture comes at the size the source makes (about 1024 px); resize it to what the game needs with the tools at hand. On success the script prints one JSON line: \`{"path", "width", "height", "bytes", "source", "model"}\`. On failure it prints the reason and exits with 1.

## Files

- \`${PROJECT_SOURCE_FILE}\`: the source's name, kind, model and address. No key.
- \`${PROJECT_SCRIPT}\`: the script, built by the plugin; it needs Node.js 18 or newer and nothing else.
${usesApi(source.kind)
    ? `- The API key is not in the project. It is kept in \`~/${KEYS_DIR}/${KEYS_FILE}\` on the machine DSH recorded the source on, readable by its user alone. On another machine, set \`DSH_IMAGE_API_KEY\` instead.`
    : '- Codex uses its own login: run `codex login` on the machine once.'}
`;
}

const inside = (root: string, file: string) => { const rel = relative(root, file); return !!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel); };
async function writeAtomic(file: string, text: string, mode?: number): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, mode === undefined ? undefined : { mode }); await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The source a project records, read and checked; null when it has none or the file is damaged. */
function parseSource(text: string): ProjectSource | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const field = (name: string) => typeof raw[name] === 'string' ? raw[name] as string : '';
    if (!field('id') || !field('name') || !SOURCE_KINDS.includes(raw.kind as SourceKind)) return null;
    return { id: field('id'), name: field('name'), kind: raw.kind as SourceKind, model: field('model'), baseUrl: field('baseUrl') };
  } catch { return null; }
}

/** The agent instruction files of the project, each once even when one links to the other, and only inside the project. */
async function agentFiles(root: string): Promise<{ name: string; file: string; exists: boolean }[]> {
  const seen = new Set<string>(), files: { name: string; file: string; exists: boolean }[] = [];
  for (const name of AGENT_FILES) {
    const path = join(root, name), info = await lstat(path).catch(() => undefined);
    const file = info?.isSymbolicLink() ? await realpath(path).catch(() => undefined) : path;
    if (!file || (info && !info.isSymbolicLink() && !info.isFile()) || !inside(root, file) || seen.has(file)) continue;
    seen.add(file);
    files.push({ name, file, exists: !!info });
  }
  return files;
}

export async function readProjectSource(root: string): Promise<ProjectSourceStatus> {
  const source = parseSource(await readFile(join(root, PROJECT_SOURCE_FILE), 'utf8').catch(() => ''));
  const files: string[] = [];
  for (const path of [PROJECT_SOURCE_FILE, PROJECT_SCRIPT, PROJECT_README]) if (await lstat(join(root, path)).then(info => info.isFile(), () => false)) files.push(path);
  for (const { name, file, exists } of await agentFiles(root)) if (exists && (await readFile(file, 'utf8').catch(() => '')).includes(BEGIN)) files.push(name);
  return { source, files };
}

/** Saves a source's key where the project's script finds it on this machine, beside the keys of other sources. */
async function saveKey(home: string, source: ProjectSource, key: string): Promise<void> {
  const dir = join(home, KEYS_DIR), file = join(dir, KEYS_FILE);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let keys: Record<string, { name: string; key: string }> = {};
  try { const raw = JSON.parse(await readFile(file, 'utf8')) as { keys?: unknown }; if (raw.keys && typeof raw.keys === 'object') keys = raw.keys as typeof keys; } catch { /* none yet */ }
  keys[source.id] = { name: source.name, key };
  await writeAtomic(file, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, 0o600);
}

/**
 * Records `bundle` in the project at `root`, or with null removes what an earlier recording wrote. Agent instruction
 * files keep everything outside the plugin's section; one the removal leaves empty is deleted.
 */
export async function writeProjectSource(root: string, bundle: ProjectBundle | null, home = homedir()): Promise<ProjectSourceStatus> {
  const dir = join(root, PROJECT_DIR), info = await lstat(dir).catch(() => undefined);
  if (info && !info.isDirectory()) throw new Error(`${PROJECT_DIR} is in the way: it is not a folder`);
  if (bundle) {
    await mkdir(dir, { recursive: true });
    await writeAtomic(join(root, PROJECT_SOURCE_FILE), `${JSON.stringify({ version: 1, ...bundle.source }, null, 2)}\n`);
    await writeAtomic(join(root, PROJECT_SCRIPT), bundle.script, 0o755);
    await writeAtomic(join(root, PROJECT_README), projectReadme(bundle.source));
    if (bundle.key !== undefined && usesApi(bundle.source.kind)) await saveKey(home, bundle.source, bundle.key);
  } else {
    for (const path of [PROJECT_SOURCE_FILE, PROJECT_SCRIPT, PROJECT_README]) await rm(join(root, path), { force: true });
    if (info) await rmdir(dir).catch(() => { /* something else lives there */ });
  }
  for (const { file, exists } of await agentFiles(root)) {
    const before = exists ? await readFile(file, 'utf8') : '';
    const rest = before.replace(BLOCK, '\n').replace(/\n{3,}$/, '\n\n');
    if (bundle) {
      const base = rest.trim() ? `${rest.trimEnd()}\n\n` : '';
      const after = `${base}${agentSection(bundle.source)}`;
      if (after !== before) { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, after); }
    } else if (before.includes(BEGIN)) {
      if (rest.trim()) await writeAtomic(file, `${rest.trimEnd()}\n`); else await rm(file, { force: true });
    }
  }
  return readProjectSource(root);
}
