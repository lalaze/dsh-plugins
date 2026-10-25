export const MARKETS = {
  'zh-CN': "China", 'en-US': "United States", 'en-GB': "United Kingdom", 'ja-JP': "Japan",
  'de-DE': "Germany", 'fr-FR': "France", 'en-CA': "Canada", 'en-AU': "Australia",
} as const;
export type Market = keyof typeof MARKETS;
export interface Wallpaper {
  id: string;
  source: 'bing' | 'local';
  date: string;
  title: string;
  copyright: string;
  copyrightUrl?: string;
  market?: Market;
}
export interface Preferences {
  enabled: boolean;
  selectedId: string | null;
  market: Market;
  opacity: number;
  blur: number;
  lastSyncAt: number;
}
export interface Library { entries: Wallpaper[]; preferences: Preferences }
export const DEFAULT_PREFERENCES: Preferences = {
  enabled: false, selectedId: null, market: 'zh-CN', opacity: 0.35, blur: 0, lastSyncAt: 0,
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const REFRESH_INTERVAL = 60 * 60 * 1000;
export const isMarket = (value: string): value is Market => Object.hasOwn(MARKETS, value);
export function validateBingId(value: string): string {
  if (value.length > 180 || !/^OHR\.[A-Za-z0-9_-]+_1920x1080\.jpg$/.test(value)) {
    throw new Error("Invalid Bing image ID");
  }
  return value;
}
export function preferencesFrom(value: unknown): Preferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
  const input = value as Record<string, unknown>;
  const number = (key: string, fallback: number, min: number, max: number) =>
    typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.max(min, Math.min(max, input[key])) : fallback;
  return {
    enabled: input.enabled === true,
    selectedId: typeof input.selectedId === 'string' ? input.selectedId : null,
    market: typeof input.market === 'string' && isMarket(input.market) ? input.market : 'zh-CN',
    opacity: number('opacity', 0.35, 0, 1), blur: number('blur', 0, 0, 24),
    lastSyncAt: number('lastSyncAt', 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
export function sortWallpapers(entries: Wallpaper[]): Wallpaper[] {
  return entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
export function dailyWallpaper(library: Library): Wallpaper | undefined {
  return library.entries.find(e => e.source === 'bing' && e.market === library.preferences.market);
}
export function currentWallpaper(library: Library): Wallpaper | undefined {
  return library.entries.find(e => e.id === library.preferences.selectedId) ?? dailyWallpaper(library)
    ?? library.entries.find(e => e.source === 'bing');
}
export function protectedWallpaper(library: Library, id: string): boolean {
  return library.preferences.selectedId === id || dailyWallpaper(library)?.id === id || currentWallpaper(library)?.id === id;
}
export function imageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
}
