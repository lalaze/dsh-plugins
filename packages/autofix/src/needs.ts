/**
 * The plugins this one works through that are not running, by package name. Repositories are reached through
 * dsh-remote-terminals, which itself works on dsh-remote-agents; fixes run as flows of dsh-model-flow. Each is known
 * by the service it provides, so one that is installed but switched off counts as missing too.
 */
export function missingPlugins(service: (name: string) => unknown): string[] {
  const has = (name: string) => { try { return !!service(name); } catch { return false; } };
  const worktrees = has('remoteAgentsWorktrees');
  return [
    // Worktrees without the machines service is a dsh-remote-agents from before the two were split: nothing is missing.
    ...(worktrees || has('remoteAgentsMachines') ? [] : ['dsh-remote-agents']),
    ...(worktrees ? [] : ['dsh-remote-terminals']),
    ...(has('modelFlow') ? [] : ['dsh-model-flow']),
  ];
}
