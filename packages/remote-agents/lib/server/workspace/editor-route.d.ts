/**
 * Serves the code editor bundle that the build writes next to the server entry. The browser loads it as a module the
 * first time an editor opens and revalidates it after that; browsers that accept gzip get it compressed.
 */
export declare function editorHandler(file: URL): (request: Request) => Promise<Response>;
