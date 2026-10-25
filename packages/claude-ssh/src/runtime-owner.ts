const OWNERS = Symbol.for('dsh-claude-ssh.runtime-owners');
interface Owner { context: object }
const registry = () => {
  const global = globalThis as typeof globalThis & { [OWNERS]?: Map<string, Owner> };
  return global[OWNERS] ??= new Map();
};
/** One native Claude integration per provider, shared by standalone and embedded builds. */
export function claimClaudeRuntime(context: object, provider: string): () => void {
  const owners = registry(), previous = owners.get(provider);
  if (previous && previous.context !== context) throw new Error('Claude SSH is already enabled. Disable dsh-claude-ssh before enabling the merged dsh-remote-agents plugin.');
  const owner = previous ?? { context }; owners.set(provider, owner);
  return () => { if (owners.get(provider) === owner) owners.delete(provider); };
}
