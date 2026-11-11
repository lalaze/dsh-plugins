// The Assets tab outside DSH, over a real folder: `node scripts/preview.mjs [folder] [port]` after a build.
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../lib/server/http.js';
import { AssetService } from '../lib/server/service.js';

export async function startPreview(folder = process.cwd(), port = 4184) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({ absWorkingDir: root, entryPoints: ['test/ui/fixture.tsx'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic' });
  const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Game Assets preview</title></head><body><script type="module">${script}</script></body></html>`;
  // Folder settings of a preview stay out of the DSH home.
  const service = new AssetService(async () => resolve(folder), join(await mkdtemp(join(tmpdir(), 'dsh-game-assets-preview-')), 'workspaces.json'));
  const handler = createHandler(service, message => console.error(message));
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/game-assets')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const answer = await handler(new Request(`http://preview.test${request.url}`, { method: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
        response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer())); return;
      }
      if (request.url !== '/' && !request.url?.startsWith('/?')) { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startPreview(process.argv[2], Number(process.argv[3] || process.env.DSH_GAME_ASSETS_PREVIEW_PORT || 4184));
  console.log(`Game Assets preview: http://127.0.0.1:${server.address().port}/`);
}
