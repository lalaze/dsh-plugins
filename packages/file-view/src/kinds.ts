/** File kinds by name, shared by the viewers and their tests; no editor code is loaded here. */

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
/** Extensions the code editor highlights, by language. */
export const CODE_EXTENSIONS: Readonly<Record<string, string>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', ipynb: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', less: 'css', yaml: 'yaml', yml: 'yaml', rs: 'rust', go: 'go', java: 'java',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', m: 'cpp', mm: 'cpp',
  sql: 'sql', xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml', csproj: 'xml', props: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell', toml: 'toml', dockerfile: 'dockerfile',
  rb: 'ruby', lua: 'lua', swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala', cs: 'csharp', dart: 'dart',
  ini: 'properties', cfg: 'properties', conf: 'properties', properties: 'properties', env: 'properties',
  ps1: 'powershell', pl: 'perl', pm: 'perl', r: 'r', diff: 'diff', patch: 'diff',
};
/** Plain text files edited without highlighting. */
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'gitignore', 'gitattributes', 'dockerignore', 'npmrc', 'nvmrc', 'editorconfig', 'lock', 'gradle', 'mk', 'cmake', 'tf', 'proto', 'graphql', 'gql', 'prisma']);
/** Files without an extension, by name. */
const NAMED: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'text', gnumakefile: 'text', procfile: 'text', gemfile: 'ruby', rakefile: 'ruby',
  license: 'text', licence: 'text', readme: 'text', changelog: 'text', authors: 'text', notice: 'text', codeowners: 'text',
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.env': 'properties',
};

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? '';
function extensionOf(path: string): string {
  const name = nameOf(path).toLowerCase(), dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
/** The image type a path previews as, if any. */
export const imageType = (path: string): string | undefined => IMAGE_TYPES[extensionOf(path)];
/** The editor language of a path: a key of `CODE_EXTENSIONS`, `text` for plain text, or undefined when it is not a text file by name. */
export function languageOf(path: string): string | undefined {
  const name = nameOf(path).toLowerCase(), extension = extensionOf(path);
  if (NAMED[name]) return NAMED[name];
  // `.env.local` and `Dockerfile.dev` keep their base kind.
  if (name.startsWith('.env.')) return 'properties';
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  if (extension in CODE_EXTENSIONS) return CODE_EXTENSIONS[extension];
  if (TEXT_EXTENSIONS.has(extension) || (name.startsWith('.') && !extension)) return 'text';
  return undefined;
}
export const isMarkdown = (path: string) => languageOf(path) === 'markdown';
/** The line separator to keep when saving: CRLF only when every line break in the text is one. */
export function lineSeparatorOf(text: string): '\r\n' | undefined {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  return crlf > 0 && crlf === (text.match(/\n/g)?.length ?? 0) ? '\r\n' : undefined;
}
