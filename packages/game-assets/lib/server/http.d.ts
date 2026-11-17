import { type AssetService } from './service.js';
/**
 * `GET ?sessionId&path` answers an image's bytes; `POST` takes a JSON `action`: `scan`, `detail`, `images` and `configure` read a workspace;
 * `retire`, `restore`, `revert`, `tag`, `note` and `save` change it (see manage.ts);
 * `project`, `setProject`, `mode` and `setMode` decide where the tab appears;
 * `sources`, `saveSource`, `deleteSource` and `defaultSource` keep the image sources, `generate` asks one for a picture,
 * `projectSource` and `setProjectSource` read and record the one the project's agents use,
 * and `h3Start`, `h3Status`, `h3Result`, `h3Stop` and `h3Discard` run and inspect host-side h3 batch redraws. */
export declare function createHandler(service: AssetService, log?: (message: string) => void): (request: Request) => Promise<Response>;
