/** A host locale service for browser regressions; default preserves the Chinese scenarios. */
export function createLocaleFixture(initial = new URLSearchParams(location.search).get('lang') ?? 'zh') {
  let active = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  const dictionaries = new Map<string, { en: Record<string, string>; zh: Record<string, string> }>();
  return {
    register(namespace: string, dictionary: { en: Record<string, string>; zh: Record<string, string> }) {
      dictionaries.set(namespace, dictionary);
      return () => { dictionaries.delete(namespace); };
    },
    getSnapshot: () => ({ active, revision }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLocale(language: string) {
      active = language; revision++;
      for (const listener of listeners) listener();
    },
  };
}
