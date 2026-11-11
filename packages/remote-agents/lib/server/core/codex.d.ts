import type { JsonlPeer } from './ssh.js';
/** The handshake of `codex app-server`, which every request on a connection follows. */
export declare function initializeCodex(peer: JsonlPeer, capabilities?: Record<string, unknown>): Promise<void>;
