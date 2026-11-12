/**
 * The plugins this one works through that are not running, by package name. Repositories are reached through
 * dsh-remote-terminals, which itself works on dsh-remote-agents; fixes run as flows of dsh-model-flow. Each is known
 * by the service it provides, so one that is installed but switched off counts as missing too.
 */
export declare function missingPlugins(service: (name: string) => unknown): string[];
