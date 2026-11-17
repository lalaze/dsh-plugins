import type { MachineBook } from './machines.js';
import type { LinkService } from './model.js';
import { request } from './proxy.js';

/**
 * `dshLink` for other plugins: the machines, and a GET into one machine's DSH through its listener (signed in there by
 * that machine's own login, as its mount is). It does not go through a mount, so it carries no hop marker.
 */
export function createLinkService(self: () => { id: string; name: string }, book: Pick<MachineBook, 'list' | 'get'>): LinkService {
  return {
    version: 1,
    self,
    machines: () => book.list(),
    get: async (id, path, options = {}) => {
      const machine = book.get(id);
      if (!machine) throw new Error('This machine is not known here.');
      if (machine.state !== 'online') throw new Error(`${machine.name} is ${machine.state}.`);
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected an absolute path.');
      const answer = await request(new URL(path, machine.url), { headers: { accept: 'application/json' }, timeoutMs: options.timeoutMs ?? 6_000, maxBytes: options.maxBytes ?? 4 * 1024 * 1024 });
      return { status: answer.status, text: answer.body.toString('utf8') };
    },
  };
}
