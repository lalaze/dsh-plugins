/**
 * Which images a project's code refers to, found by reading the code as text. Nothing is executed, so a path the game
 * builds at run time is reported as a weaker `pattern`, `folder` or `name` reference rather than as a use.
 */
import { IMAGE_EXTENSIONS, REF_LIMIT, extensionOf, type Reference, type ReferenceKind, type Usage } from './domain.js';

/** Files that are code wherever they are: every reference in them counts. */
export const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'gd', 'gdshader', 'tscn', 'tres', 'godot', 'cs', 'lua', 'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'dart', 'hx', 'as',
  'glsl', 'wgsl', 'shader', 'php', 'sh']);
/**
 * Manifests, atlases and maps. One of these counts only when code, or another counted file, names it: metadata a
 * generator left beside its images would otherwise mark every image it lists as used.
 */
export const DATA_EXTENSIONS = new Set(['json', 'json5', 'jsonc', 'yaml', 'yml', 'xml', 'toml', 'txt', 'csv', 'atlas', 'fnt', 'plist', 'tmx', 'tmj', 'tsj', 'ldtk', 'webmanifest']);

const IMAGES = new Set<string>(IMAGE_EXTENSIONS);
const TARGETS = [...new Set([...IMAGE_EXTENSIONS, ...DATA_EXTENSIONS])].sort((a, b) => b.length - a.length);
/** The end of a path: a dot, a known extension, and no further name character. */
const ENDING = new RegExp(`\\.(${TARGETS.join('|')})(?![A-Za-z0-9_])`, 'gi');
const PATH_CHAR = /[A-Za-z0-9_@~.\-/\\%]/;
const TOKEN_LIMIT = 400;
const WORD = /[A-Za-z0-9_][A-Za-z0-9_-]{2,}/g;
const FOLDER = /['"`]((?:\.{0,2}\/)?(?:[A-Za-z0-9_@.-]+\/)+)['"`]/g;
const SNIPPET = 160;

export interface Location { file: string; line: number; text: string }
export interface Mention { token: string; pattern: boolean; extension: string; line: number; column: number }
export interface Extracted { mentions: Mention[]; folders: { dir: string; line: number; column: number }[]; lines: string[] }

/**
 * A path as written in code, comparable with a workspace path: `/` separators, no leading `./`, `../`, `/`, `~/` or
 * `@/`, and each interpolation (`${id}`, `{id}`, `%s`, `%d`) as `*`. Undefined when nothing nameable is left.
 */
export function normalizeToken(raw: string): { token: string; pattern: boolean } | undefined {
  let token = raw.replace(/\\+/g, '/').replace(/\$?\{[^{}]*\}/g, '*').replace(/%[sd]/g, '*').replace(/\*{2,}/g, '*');
  if (/[{}$%]/.test(token)) return undefined;
  const parts = token.split('/').filter(part => part !== '' && part !== '.');
  while (parts.length && /^(?:\.\.|~|@)$/.test(parts[0])) parts.shift();
  if (parts.some(part => part === '..')) return undefined;
  token = parts.join('/');
  return token ? { token, pattern: token.includes('*') } : undefined;
}

/** The first character of the path that ends just before `end`, walking back over path characters and interpolations. */
function tokenStart(line: string, end: number): number {
  let start = end;
  while (start > 0 && end - start < TOKEN_LIMIT) {
    const char = line[start - 1];
    if (PATH_CHAR.test(char)) { start--; continue; }
    if (char === '}') {
      const open = line.lastIndexOf('{', start - 2);
      if (open < 0 || line.indexOf('}', open) !== start - 1) break;
      start = open > 0 && line[open - 1] === '$' ? open - 1 : open;
      continue;
    }
    break;
  }
  return start;
}

/** Every image or data path written in `text`, and every quoted folder such as `'art/cats/'`. */
export function extract(text: string): Extracted {
  const lines = text.split('\n'), mentions: Mention[] = [], folders: Extracted['folders'] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length < 5) continue;
    ENDING.lastIndex = 0;
    for (let match = ENDING.exec(line); match; match = ENDING.exec(line)) {
      const start = tokenStart(line, match.index);
      if (start === match.index) continue;
      const normalized = normalizeToken(line.slice(start, match.index));
      if (normalized) mentions.push({ ...normalized, extension: match[1].toLowerCase(), line: index + 1, column: start });
    }
    if (line.includes('/')) {
      FOLDER.lastIndex = 0;
      for (let match = FOLDER.exec(line); match; match = FOLDER.exec(line)) {
        const dir = normalizeToken(match[1])?.token;
        if (dir && !dir.includes('*')) folders.push({ dir, line: index + 1, column: match.index });
      }
    }
  }
  return { mentions, folders, lines };
}

/** The line around `column`, short enough to show: a minified line is cut to the part that holds the reference. */
export function snippet(line: string, column: number): string {
  if (line.length <= SNIPPET) return line.trim();
  const start = Math.max(0, Math.min(column - 40, line.length - SNIPPET));
  return `${start ? '…' : ''}${line.slice(start, start + SNIPPET).trim()}${start + SNIPPET < line.length ? '…' : ''}`;
}

const withoutExtension = (path: string) => path.replace(/\.[A-Za-z0-9]+$/, '');
const endsWith = (whole: string[], tail: string[]) => {
  if (tail.length > whole.length) return false;
  for (let i = 1; i <= tail.length; i++) if (whole[whole.length - i] !== tail[tail.length - i]) return false;
  return true;
};

interface Entry { index: number; parts: string[]; extension: string }
/** Paths found by their ending: `cats/a.png` finds `public/art/cats/a.png`. Image paths compare without the extension. */
export class SuffixIndex {
  private readonly byName = new Map<string, Entry[]>();
  private readonly entries: Entry[] = [];
  constructor(paths: readonly string[], private readonly ignoreExtension: boolean) {
    paths.forEach((path, index) => {
      const parts = (ignoreExtension ? withoutExtension(path) : path).split('/');
      const entry = { index, parts, extension: extensionOf(path) };
      this.entries.push(entry);
      const name = parts[parts.length - 1], list = this.byName.get(name);
      if (list) list.push(entry); else this.byName.set(name, [entry]);
    });
  }
  /** Entries named like the token's last part, the ones the token's extension matches, and the token's depth. */
  private candidates(token: string, extension: string) {
    // Tokens arrive without their extension; data files are indexed with theirs.
    const parts = token.split('/');
    if (!this.ignoreExtension) parts[parts.length - 1] += `.${extension}`;
    const found = (this.byName.get(parts[parts.length - 1]) ?? []).filter(entry => endsWith(entry.parts, parts));
    return { found, depth: parts.length };
  }
  /**
   * What a literal path refers to. A path of two or more parts, or a bare name only one entry has, is certain; a bare
   * name several entries share is certain for the single one with the same extension and a `name` reference for the rest.
   */
  literal(token: string, extension: string): { index: number; kind: ReferenceKind }[] {
    const { found, depth } = this.candidates(token, extension);
    if (depth > 1 || found.length === 1) return found.map(entry => ({ index: entry.index, kind: 'path' as const }));
    const exact = found.filter(entry => entry.extension === extension);
    return found.map(entry => ({ index: entry.index, kind: exact.length === 1 && exact[0] === entry ? 'path' as const : 'name' as const }));
  }
  /** Entries a path with `*` interpolations could name; empty when the pattern has too little literal text to mean anything. */
  pattern(token: string): number[] {
    const parts = token.split('/');
    while (parts.length && /^\*+$/.test(parts[0])) parts.shift();
    if (parts.join('').replace(/[^A-Za-z0-9]/g, '').length < 3) return [];
    const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    const regex = new RegExp(`(?:^|/)${parts.map(escape).join('/')}$`);
    return this.entries.filter(entry => regex.test(entry.parts.join('/'))).map(entry => entry.index);
  }
  /** Entries with this bare name, for words that are a name without its extension. */
  named(name: string): number[] { return (this.byName.get(name) ?? []).map(entry => entry.index); }
  names(): IterableIterator<string> { return this.byName.keys(); }
}

/** Images directly inside a folder written as a literal; one-part folders must be the only folder of that name. */
function folderMembers(assets: readonly string[]) {
  const members = new Map<string, number[]>(), byName = new Map<string, string[]>();
  assets.forEach((path, index) => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!dir) return;
    const list = members.get(dir);
    if (list) { list.push(index); return; }
    members.set(dir, [index]);
    const name = dir.slice(dir.lastIndexOf('/') + 1), named = byName.get(name);
    if (named) named.push(dir); else byName.set(name, [dir]);
  });
  return (dir: string): number[] => {
    const parts = dir.split('/'), named = byName.get(parts[parts.length - 1]) ?? [];
    if (parts.length === 1) return named.length === 1 && dir.length >= 3 ? members.get(named[0])! : [];
    return named.filter(path => endsWith(path.split('/'), parts)).flatMap(path => members.get(path)!);
  };
}

export interface ReferenceInput {
  /** Image paths, relative to the workspace. */
  assets: readonly string[];
  /** Code files: all are read. */
  sources: readonly string[];
  /** Data files: read once a file already read names them. */
  data: readonly string[];
  /** A file's text, or undefined when it is unreadable, binary or too large. */
  read(path: string): Promise<string | undefined>;
}
export interface ReferenceOutput { refs: Reference[][]; counts: number[]; usage: Usage[]; filesRead: number }

const RANK: Record<ReferenceKind, number> = { path: 0, pattern: 1, folder: 2, name: 3 };
const CONCURRENCY = 16;

/** References to each image, strongest first, with a verdict: used, maybe (only computed or ambiguous references), unused. */
export async function findReferences(input: ReferenceInput): Promise<ReferenceOutput> {
  const assets = new SuffixIndex(input.assets, true), data = new SuffixIndex(input.data, false), inFolder = folderMembers(input.assets);
  const found = input.assets.map(() => new Map<string, Reference>());
  const add = (index: number, kind: ReferenceKind, file: string, at: { line: number; column: number }, lines: string[]) => {
    const key = `${file}:${at.line}`, previous = found[index].get(key);
    if (!previous || RANK[kind] < RANK[previous.kind]) found[index].set(key, { file, line: at.line, kind, text: snippet(lines[at.line - 1], at.column) });
  };
  // Words are matched against names without an extension, such as a texture key equal to its file name.
  const stems = new Set<string>();
  // A plain word such as `sheet` or `source` turns up in any code; only names with some shape of their own are evidence.
  for (const name of assets.names()) if (name.length >= 4 && /^[A-Za-z0-9_][A-Za-z0-9_-]+$/.test(name) && /[A-Za-z]/.test(name) && /[-_0-9]|[a-z][A-Z]/.test(name)) stems.add(name);
  const words = input.assets.map(() => new Map<string, Reference>());
  const patterns = new Map<string, number[]>();

  const queue = [...input.sources], seen = new Set(queue);
  let filesRead = 0;
  const scan = async (file: string) => {
    const text = await input.read(file);
    if (text === undefined) return;
    filesRead++;
    const { mentions, folders, lines } = extract(text);
    for (const mention of mentions) {
      if (!IMAGES.has(mention.extension)) {
        if (mention.pattern) continue;
        // A bare name such as `package.json` that many files have says nothing about which one is meant.
        const targets = data.literal(mention.token, mention.extension);
        if (targets.length <= 3) for (const { index } of targets) {
          const path = input.data[index];
          if (!seen.has(path)) { seen.add(path); queue.push(path); }
        }
      } else if (mention.pattern) {
        let matched = patterns.get(mention.token);
        if (!matched) patterns.set(mention.token, matched = assets.pattern(mention.token));
        for (const index of matched) add(index, 'pattern', file, mention, lines);
      } else for (const { index, kind } of assets.literal(mention.token, mention.extension)) add(index, kind, file, mention, lines);
    }
    for (const folder of folders) for (const index of inFolder(folder.dir)) add(index, 'folder', file, folder, lines);
    if (stems.size) lines.forEach((line, at) => {
      WORD.lastIndex = 0;
      for (let match = WORD.exec(line); match; match = WORD.exec(line)) {
        if (!stems.has(match[0])) continue;
        for (const index of assets.named(match[0])) {
          const key = `${file}:${at + 1}`;
          if (words[index].size < REF_LIMIT && !words[index].has(key)) words[index].set(key, { file, line: at + 1, kind: 'name', text: snippet(line, match.index) });
        }
      }
    });
  };
  // Data files join the queue while it drains, so workers keep taking from it until every one is idle.
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    const next = () => {
      if (!queue.length && !active) { resolve(); return; }
      while (active < CONCURRENCY && queue.length) {
        active++;
        scan(queue.shift()!).then(() => { active--; next(); }, reject);
      }
    };
    next();
  });

  const refs: Reference[][] = [], counts: number[] = [], usage: Usage[] = [];
  found.forEach((map, index) => {
    // A bare word is the weakest evidence; it is reported only when nothing else names the image.
    const all = [...(map.size ? map : words[index]).values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);
    counts.push(all.length);
    refs.push(all.slice(0, REF_LIMIT));
    usage.push(!all.length ? 'unused' : all[0].kind === 'path' ? 'used' : 'maybe');
  });
  return { refs, counts, usage, filesRead };
}
