/**
 * Minimal slice of the DSH Host API used by this plugin.
 * Shapes match `@deepseek-ai/dsh-host-webserver` and `@deepseek-ai/cordis`
 * without pulling DSH's full host type graph or augmenting Cordis globally.
 */

/**
 * A named route answered by a Fetch resource. The web server answers methods other than
 * GET and HEAD with 405 and drops the body of a HEAD response itself.
 */
export interface WebResourceRoute {
  kind: 'exact' | 'prefix';
  /** Absolute pathname, no trailing slash. */
  path: string;
  resource: (request: Request) => Promise<Response>;
}

export interface WebServer {
  register(route: WebResourceRoute): () => void;
}

export interface RegistryFiber {
  readonly config?: unknown;
}

export interface RegistryRuntime {
  readonly name?: string;
  readonly fibers?: Iterable<RegistryFiber>;
}

export interface PluginRegistry {
  values(): Iterable<RegistryRuntime>;
}

export interface LoggerLike {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}
