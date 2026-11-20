/** The inline script a mounted page gets (rewrite.ts `injectFrameBrowser`), built to lib/frame-browser.js. */
import { FRAME_CONFIG_GLOBAL } from '../rewrite.js';
import { installFrameBrowser, type FrameConfig } from './browser.js';

try {
  const win = globalThis as unknown as Record<string, unknown>;
  installFrameBrowser(win, win[FRAME_CONFIG_GLOBAL] as FrameConfig | undefined);
} catch { /* the page works without the panel */ }
