/** A session's model as the vendor logo DSH's sidebar shows for it (dsh-session-models' rules). */
import type { ModelSelection } from '../../src/shared/protocol.js'
import { ICONS } from './icons.js'

export type BrandId = keyof typeof ICONS

// The model name decides first: aggregators and multi-model CLIs host many vendors.
const MODEL_RULES: readonly (readonly [RegExp, BrandId])[] = [
  [/claude|sonnet|opus|haiku/i, 'claude'], [/deepseek/i, 'deepseek'], [/gemini|gemma/i, 'gemini'], [/grok/i, 'grok'],
  [/qwen|qwq/i, 'qwen'], [/kimi|moonshot/i, 'kimi'], [/\bglm|chatglm/i, 'zhipu'], [/doubao/i, 'doubao'],
  [/minimax|\babab/i, 'minimax'], [/mistral|codestral|devstral|magistral/i, 'mistral'], [/\bgpt|\bo[1-9](?:-|$)|codex|chatgpt/i, 'openai'],
]
const PROVIDER_RULES: readonly (readonly [RegExp, BrandId])[] = [
  [/anthropic|claude/i, 'claude'], [/openai|codex|azure/i, 'openai'], [/deepseek|^dsh$/i, 'deepseek'], [/gemini|google|vertex/i, 'gemini'],
  [/xai|grok/i, 'grok'], [/qwen|dashscope|bailian|alibaba/i, 'qwen'], [/moonshot|kimi/i, 'kimi'], [/zhipu|bigmodel|glm/i, 'zhipu'],
  [/doubao|volcengine/i, 'doubao'], [/minimax/i, 'minimax'], [/mistral/i, 'mistral'], [/antigravity/i, 'antigravity'], [/codebuddy/i, 'codebuddy'],
]
const match = (rules: typeof MODEL_RULES, text: string) => rules.find(([pattern]) => pattern.test(text))?.[1]
const decode = (part: string) => { try { return decodeURIComponent(part) } catch { return part } }

/** Brand fills; `null` marks monochrome logos, which follow the text color. */
const BRAND_COLORS: Readonly<Record<BrandId, string | null>> = {
  claude: '#D97757', openai: null, deepseek: '#4D6BFE', gemini: '#3186FF', grok: null, qwen: '#615CED', kimi: null,
  zhipu: '#3859FF', doubao: '#3A6BFF', minimax: '#F23F5D', mistral: '#FA500F', antigravity: '#3186FF', codebuddy: '#6C4DFF', generic: null,
}

/** dsh-remote-agents routes are `remote-cli[-<cli>]` with model ids `<project>/<cli>/<native model>[/<tier>]`. */
export function brandOf(selection: ModelSelection | undefined): BrandId {
  if (!selection) return 'generic'
  let cli: string | undefined, name = selection.model
  if (selection.provider === 'remote-cli' || selection.provider.startsWith('remote-cli-')) {
    const parts = selection.model.split('/')
    if (parts.length === 3 || parts.length === 4) { cli = decode(parts[1]); name = decode(parts[2]) }
    else if (selection.provider !== 'remote-cli') cli = selection.provider.slice('remote-cli-'.length)
  }
  return match(MODEL_RULES, name) ?? match(PROVIDER_RULES, cli ?? selection.provider) ?? 'generic'
}

const urls = new Map<BrandId, string>()
export function brandStyle(brand: BrandId): Record<string, string> {
  let url = urls.get(brand)
  if (!url) { url = `url("data:image/svg+xml,${encodeURIComponent(ICONS[brand])}")`; urls.set(brand, url) }
  return { '--brand-icon': url, '--brand-color': BRAND_COLORS[brand] ?? 'var(--fg)' }
}
