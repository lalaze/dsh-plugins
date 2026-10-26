export declare const MARKETS: {
    readonly 'zh-CN': "China";
    readonly 'en-US': "United States";
    readonly 'en-GB': "United Kingdom";
    readonly 'ja-JP': "Japan";
    readonly 'de-DE': "Germany";
    readonly 'fr-FR': "France";
    readonly 'en-CA': "Canada";
    readonly 'en-AU': "Australia";
};
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
export interface Library {
    entries: Wallpaper[];
    preferences: Preferences;
}
export declare const DEFAULT_PREFERENCES: Preferences;
export declare const MAX_IMAGE_BYTES: number;
export declare const REFRESH_INTERVAL: number;
export declare const isMarket: (value: string) => value is Market;
export declare function validateBingId(value: string): string;
export declare function preferencesFrom(value: unknown): Preferences;
export declare function sortWallpapers(entries: Wallpaper[]): Wallpaper[];
export declare function dailyWallpaper(library: Library): Wallpaper | undefined;
export declare function currentWallpaper(library: Library): Wallpaper | undefined;
export declare function protectedWallpaper(library: Library, id: string): boolean;
export declare function imageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | undefined;
