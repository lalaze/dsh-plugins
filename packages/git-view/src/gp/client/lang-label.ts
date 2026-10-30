/**
 * Display spelling for the platform's language ids (shiki-style, all
 * lowercase, e.g. `typescript`): conventional branding where it exists
 * (TypeScript, JSX, C++), first-letter capitalization as the fallback. Used
 * by the file-properties dialog's type row.
 */
const LANG_DISPLAY: Record<string, string> = {
  bash: 'Bash', c: 'C', cpp: 'C++', csharp: 'C#', css: 'CSS', dockerfile: 'Dockerfile',
  go: 'Go', html: 'HTML', java: 'Java', javascript: 'JavaScript', json: 'JSON',
  jsx: 'JSX', kotlin: 'Kotlin', markdown: 'Markdown', php: 'PHP', python: 'Python',
  ruby: 'Ruby', rust: 'Rust', scss: 'SCSS', shellscript: 'Shell', sql: 'SQL',
  swift: 'Swift', toml: 'TOML', tsx: 'TSX', typescript: 'TypeScript',
  vue: 'Vue', xml: 'XML', yaml: 'YAML',
}

export function langLabel(lang: string): string {
  return LANG_DISPLAY[lang] ?? capitalize(lang)
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
