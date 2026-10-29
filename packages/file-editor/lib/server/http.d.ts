import { type LocalFiles } from './files.js';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export declare const CLIENT_HEADER = "X-DSH-File-Editor";
export declare function createHandler(files: LocalFiles, log?: (message: string) => void): (request: Request) => Promise<Response>;
