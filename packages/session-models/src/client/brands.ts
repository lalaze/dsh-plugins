import { ICONS } from './icons.js';

export type BrandId = keyof typeof ICONS;
export interface Selection { readonly provider: string; readonly model: string }
/** What a sidebar row shows: the model vendor, the native model name, and the remote CLI that runs it. */
export interface ModelBadge { readonly brand: BrandId; readonly model: string; readonly cli?: string }

// The model name decides first: aggregators and multi-model CLIs (Antigravity, CodeBuddy) host many vendors.
const MODEL_RULES: readonly (readonly [RegExp, BrandId])[] = [
  [/claude|sonnet|opus|haiku/i, 'claude'],
  [/deepseek/i, 'deepseek'],
  [/gemini|gemma/i, 'gemini'],
  [/grok/i, 'grok'],
  [/qwen|qwq/i, 'qwen'],
  [/kimi|moonshot/i, 'kimi'],
  [/\bglm|chatglm/i, 'zhipu'],
  [/doubao/i, 'doubao'],
  [/minimax|\babab/i, 'minimax'],
  [/mistral|codestral|devstral|magistral/i, 'mistral'],
  [/\bgpt|\bo[1-9](?:-|$)|codex|chatgpt/i, 'openai'],
];
const PROVIDER_RULES: readonly (readonly [RegExp, BrandId])[] = [
  [/anthropic|claude/i, 'claude'],
  [/openai|codex|azure/i, 'openai'],
  [/deepseek|^dsh$/i, 'deepseek'],
  [/gemini|google|vertex/i, 'gemini'],
  [/xai|grok/i, 'grok'],
  [/qwen|dashscope|bailian|alibaba/i, 'qwen'],
  [/moonshot|kimi/i, 'kimi'],
  [/zhipu|bigmodel|glm/i, 'zhipu'],
  [/doubao|volcengine/i, 'doubao'],
  [/minimax/i, 'minimax'],
  [/mistral/i, 'mistral'],
  [/antigravity/i, 'antigravity'],
  [/codebuddy/i, 'codebuddy'],
];
const match = (rules: typeof MODEL_RULES, text: string) => rules.find(([pattern]) => pattern.test(text))?.[1];
const decode = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };

/** Native names used by dsh-remote-agents for its CLI routes. */
export const CLI_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy Code',
};

/**
 * Resolve a DSH model selection to a row badge.
 * dsh-remote-agents routes are `remote-cli` or `remote-cli-<cli>`, with model ids `<project>/<cli>/<native model>`.
 */
export function describeSelection({ provider, model }: Selection): ModelBadge {
  let cli: string | undefined, name = model;
  if (provider === 'remote-cli' || provider.startsWith('remote-cli-')) {
    const parts = model.split('/');
    if (parts.length === 3) { cli = decode(parts[1]); name = decode(parts[2]); }
    else if (provider !== 'remote-cli') cli = provider.slice('remote-cli-'.length);
  }
  const brand = match(MODEL_RULES, name) ?? match(PROVIDER_RULES, cli ?? provider) ?? 'generic';
  return cli ? { brand, model: name, cli } : { brand, model: name };
}

/** Brand fills; `null` marks monochrome logos, which follow the theme's label color. */
export const BRAND_COLORS: Readonly<Record<BrandId, string | null>> = {
  claude: '#D97757', openai: null, deepseek: '#4D6BFE', gemini: '#3186FF', grok: null, qwen: '#615CED', kimi: null,
  zhipu: '#3859FF', doubao: '#3A6BFF', minimax: '#F23F5D', mistral: '#FA500F', antigravity: '#3186FF', codebuddy: '#6C4DFF', generic: null,
};
export const iconUrl = (brand: BrandId) => `url("data:image/svg+xml,${encodeURIComponent(ICONS[brand])}")`;
