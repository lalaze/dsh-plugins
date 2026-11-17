import type { MachineBook } from './machines.js';
import type { LinkService } from './model.js';
/**
 * `dshLink` for other plugins: the machines, and a GET into one machine's DSH through its listener (signed in there by
 * that machine's own login, as its mount is). It does not go through a mount, so it carries no hop marker.
 */
export declare function createLinkService(self: () => {
    id: string;
    name: string;
}, book: Pick<MachineBook, 'list' | 'get'>): LinkService;
