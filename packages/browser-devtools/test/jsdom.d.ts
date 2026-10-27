// The part of jsdom these tests use; the package ships no types.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'outside-only' | 'dangerously'; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis & { eval(code: string): unknown };
  }
}
