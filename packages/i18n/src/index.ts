/** Build-time shared code: esbuild includes this in each independent plugin archive. */
export type Params = Record<string, string | number>;
export interface LocaleRuntime {
  register(namespace: string, dictionaries: { en: Record<string, string>; zh: Record<string, string> }): (() => void) | undefined;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { active: string; revision: number };
}
export interface LocaleContext { get?(name: 'locale'): LocaleRuntime | undefined }

export const languageOf = (tag?: string): 'en' | 'zh' => /^zh(?:[-_]|$)/i.test(tag ?? '') ? 'zh' : 'en';
export const fill = (text: string, params: Params = {}): string => text.replace(/\{(\w+)\}/g, (whole, key: string) => Object.hasOwn(params, key) ? String(params[key]) : whole);

export function createI18n(namespace: string, zh: Readonly<Record<string, string>>) {
  let runtime: LocaleRuntime | undefined;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const activeLocale = () => languageOf(runtime?.getSnapshot().active);
  // API errors arrive as English sentences with values already filled in. Match only known
  // templates, leaving third-party messages and user content intact.
  const templates = Object.entries(zh).filter(([en]) => /\{\w+\}/.test(en)).map(([en, translated]) => {
    const keys: string[] = [];
    const source = en.split(/(\{\w+\})/g).map(part => {
      if (/^\{\w+\}$/.test(part)) { keys.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { regex: new RegExp(`^${source}$`), keys, translated };
  });
  const ui = (text: string, params?: Params): string => {
    if (activeLocale() === 'en') return fill(text, params);
    if (Object.hasOwn(zh, text)) return fill(zh[text], params);
    for (const { regex, keys, translated } of templates) {
      const match = regex.exec(text);
      if (match) return fill(translated, Object.fromEntries(keys.map((key, index) => [key, match[index + 1]])));
    }
    return fill(text, params);
  };
  return {
    ui,
    activeLocale,
    formatLocale: () => activeLocale() === 'zh' ? 'zh-CN' : 'en-US',
    localizeError: (error: unknown) => ui(error instanceof Error ? error.message : String(error)),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    installLocale(ctx: LocaleContext): () => void {
      const service = ctx.get?.('locale');
      if (!service) return () => {};
      const dispose = service.register(namespace, { en: Object.fromEntries(Object.keys(zh).map(key => [key, key])), zh: { ...zh } });
      runtime = service;
      const unsubscribe = service.subscribe(emit);
      emit();
      return () => {
        unsubscribe(); dispose?.();
        if (runtime === service) { runtime = undefined; emit(); }
      };
    },
  };
}
