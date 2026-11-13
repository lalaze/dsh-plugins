/** Runs workspace requests on a machine saved in Remote Agents, by sending it the bundled remote-agent script. */
import { gunzipSync } from 'node:zlib';
import { AssetError } from './workspace.js';
export const REMOTE_BEGIN = '<<DSH-GAME-ASSETS:', REMOTE_END = ':DSH-GAME-ASSETS>>';
const HEREDOC = 'DSH_GAME_ASSETS_SCRIPT_END';
/** Paths one remote request carries. The whole command is one shell argument, which Linux limits to 128 KiB. */
export const REMOTE_CHUNK = 200;
/** The shell command that runs `script` with `request` on the remote machine's Node.js. */
export function remoteCommand(script, request) {
    const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    if (script.includes(HEREDOC))
        throw new Error('The remote script may not contain its own end marker');
    return `node --no-warnings - <<'${HEREDOC}'\nglobalThis.__DSH_GAME_ASSETS_REQUEST__=${JSON.stringify(encoded)};\n${script}\n${HEREDOC}`;
}
/** The answer inside a remote run's output, which may carry warnings of the shell or of Node.js around it. */
export function remoteAnswer(output, exitCode) {
    const begin = output.lastIndexOf(REMOTE_BEGIN), end = begin < 0 ? -1 : output.indexOf(REMOTE_END, begin);
    if (begin < 0 || end < 0) {
        const said = output.replace(/\s+/g, ' ').trim().slice(-300);
        if (/node: (?:command )?not found|command not found: node/.test(said))
            throw new AssetError('Node.js was not found on the remote machine', 502);
        throw new AssetError(`The remote machine could not answer${exitCode === null ? '' : ` (exit ${exitCode})`}: ${said || 'no output'}`, 502);
    }
    let answer;
    try {
        answer = JSON.parse(gunzipSync(Buffer.from(output.slice(begin + REMOTE_BEGIN.length, end), 'base64')).toString('utf8'));
    }
    catch {
        throw new AssetError('The remote machine’s answer could not be read', 502);
    }
    if (!answer.ok)
        throw new AssetError(typeof answer.error === 'string' ? answer.error : 'The workspace could not be scanned', typeof answer.status === 'number' ? answer.status : 500);
    return answer.result;
}
const TIMEOUT_MS = { scan: 180_000, place: 300_000 };
/** Output kept from one run: a scan of tens of thousands of images, compressed, stays far below it. */
const OUTPUT_LIMIT = 96 * 1024 * 1024;
/**
 * One request on the conversation's machine, in its workspace folder, which is verified again once the connection is
 * ready. An `upload` travels first, over the same connection, as no shell argument could hold a picture.
 */
export async function runRemote(machines, sessionId, target, script, request, upload) {
    const signal = AbortSignal.timeout(TIMEOUT_MS[request.op] ?? 60_000), chunks = [];
    let size = 0;
    const exitCode = await machines.withWorkspace(target.hostId, async () => { await machines.target(sessionId, signal, target); }, async (files) => {
        if (upload) {
            if (typeof files.attach !== 'function')
                throw new AssetError('Saving pictures in a remote workspace needs a newer Remote Agents', 409);
            await files.attach(target.cwd, upload.path, (async function* () { yield upload.data; })(), upload.data.length, upload.sha256, signal);
        }
        return files.stream(target.cwd, remoteCommand(script, request), {}, data => { if ((size += data.length) <= OUTPUT_LIMIT)
            chunks.push(Buffer.from(data)); }, signal);
    }).catch(error => { throw error instanceof AssetError ? error : new AssetError(`The remote machine could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502); });
    if (signal.aborted)
        throw new AssetError('The remote machine took too long to answer', 504);
    return remoteAnswer(Buffer.concat(chunks).toString('latin1'), exitCode);
}
