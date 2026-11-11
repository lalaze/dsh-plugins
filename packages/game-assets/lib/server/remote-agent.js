/**
 * The plugin's half that runs on a remote machine. The host sends this file, bundled into one script, to `node` over the
 * machine's SSH connection with a request in front of it; the script answers once on standard output and exits. It
 * works in the directory it is started in, which Remote Agents has checked to be the conversation's workspace.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Library } from './manage.js';
import { REMOTE_BEGIN, REMOTE_END } from './remote.js';
import { Scanner } from './scan.js';
import { AssetError, handle } from './workspace.js';
async function main(encoded) {
    let answer;
    try {
        const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        const root = await realpath(process.cwd()), scanner = new Scanner();
        // Image sizes and hashes of unchanged files are kept between scans, as every scan here is a new process.
        const cache = join(homedir(), '.dsh-remote-agents', 'game-assets', `${createHash('sha1').update(root).digest('hex')}.json`);
        let before = '';
        if (request.op === 'scan') {
            before = await readFile(cache, 'utf8').catch(() => '');
            try {
                scanner.restore(JSON.parse(before));
            }
            catch { /* no cache yet, or a damaged one */ }
        }
        const result = await handle(root, request, scanner, new Library(root));
        if (request.op === 'scan') {
            const after = JSON.stringify(scanner.snapshot());
            if (after !== before)
                await mkdir(join(cache, '..'), { recursive: true }).then(() => writeFile(cache, after, { mode: 0o600 })).catch(() => { });
        }
        answer = { ok: true, result };
    }
    catch (error) {
        answer = { ok: false, error: error instanceof Error ? error.message : String(error), status: error instanceof AssetError ? error.status : 500 };
    }
    process.stdout.write(`\n${REMOTE_BEGIN}${gzipSync(JSON.stringify(answer)).toString('base64')}${REMOTE_END}\n`);
}
const request = globalThis.__DSH_GAME_ASSETS_REQUEST__;
if (typeof request === 'string')
    void main(request);
