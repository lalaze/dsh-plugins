import { type AssetService } from './service.js';
/**
 * `GET ?sessionId&path` answers an image's bytes; `POST` takes a JSON `action`: `scan`, `detail`, `images` and `configure` read a workspace;
 * `retire`, `restore`, `revert`, `tag`, `note` and `save` change it (see manage.ts);
 * `project`, `setProject`, `mode` and `setMode` decide where the tab appears;
 * `sources`, `saveSource`, `deleteSource` and `defaultSource` keep the image sources, `generate` asks one for a picture,
 * and `projectSource` and `setProjectSource` read and record the one the project's agents use. */
export declare function createHandler(service: AssetService, log?: (message: string) => void): (request: Request) => Promise<Response>;
