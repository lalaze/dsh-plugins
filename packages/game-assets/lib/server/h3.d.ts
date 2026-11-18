import type { Aspect, BootProgress } from './domain.js';
import { AssetError } from './workspace.js';
/** Up to 10 min waiting for a free GPU plus ~11 min of setup, with room for a slow weight download. */
export declare const H3_BOOT_TIMEOUT_MS: number;
export declare const H3_DRAW_TIMEOUT_MS: number;
export declare const H3_DOWN_TIMEOUT_MS: number;
export declare const H3_STATUS_TIMEOUT_MS = 60000;
/** An error that means the h3 installation, authorization or Colab VM itself is unavailable for the rest of the batch. */
export declare class H3FatalError extends AssetError {
}
export interface H3Options {
    /** Starts h3 through the user's login shell (default true), as DSH launched from the Dock may not have ~/.local/bin in PATH. */
    loginShell?: boolean;
    /** The executable to run; tests pass a stand-in script here. */
    command?: string;
    bootTimeoutMs?: number;
    drawTimeoutMs?: number;
    downTimeoutMs?: number;
    statusTimeoutMs?: number;
}
export interface H3DrawRequest {
    prompt: string;
    /** Absolute path of the reference image staged on the DSH host. */
    reference: string;
    aspect: Aspect;
    transparent: boolean;
    /** Folder on the DSH host where `h3 edit -o` writes its PNG and metadata. */
    outDir: string;
}
export interface H3Picture {
    file: string;
    data: Buffer;
    mediaType: string;
    width?: number;
    height?: number;
}
/** Formats the shared prompt for `h3 edit`, which refers to its reference image as `<Picture 1>`. */
export declare function h3Prompt(prompt: string): string;
/** Checks whether the default h3 Colab VM is already running before starting a batch. */
export declare function status(options?: H3Options, signal?: AbortSignal): Promise<{
    running: boolean;
}>;
/** What a line of `h3 up` says about finding a GPU, applied to the progress so far; undefined for other lines. */
export declare function bootProgress(line: string, now: BootProgress): BootProgress | undefined;
/** Boots the Colab VM and starts ComfyUI (`h3 up`), telling `onProgress` how the search for a GPU goes. */
export declare function up(options?: H3Options, signal?: AbortSignal, onProgress?: (progress: BootProgress) => void): Promise<void>;
/** Redraws one picture from its reference image at 16 MP (`h3 edit --mp 16 -o <outDir> --json`). */
export declare function draw(request: H3DrawRequest, options?: H3Options, signal?: AbortSignal): Promise<H3Picture>;
/** Shuts down the Colab VM (`h3 down`). */
export declare function down(options?: H3Options): Promise<void>;
