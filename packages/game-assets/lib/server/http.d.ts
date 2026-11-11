import { type AssetService } from './service.js';
/**
 * `GET ?sessionId&path` answers an image's bytes; `POST` takes a JSON `action`: `scan`, `detail` and `configure` read a workspace;
 * `retire`, `restore`, `tag` and `note` change it (see manage.ts);
 * `project`, `setProject`, `mode` and `setMode` decide where the tab appears. */
export declare function createHandler(service: AssetService, log?: (message: string) => void): (request: Request) => Promise<Response>;
