import { RemoteError, remotePath } from './domain.js';
import { FILE_LIMIT, TEXT_LIMIT } from './workspace-domain.js';
import { createHash } from 'node:crypto';
import { WORKSPACE_RUNNER } from './workspace-runner.js';
import { quote } from './ssh.js';
export class WorkspaceFiles {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    command(cwd, operation) {
        return `node -e ${quote(WORKSPACE_RUNNER)} ${quote(JSON.stringify({ ...operation, cwd: remotePath(cwd) }))}`;
    }
    decode(output) {
        const response = JSON.parse(output);
        if (response.error)
            throw new RemoteError(response.error, response.status ?? 400);
        return response.result;
    }
    async operate(cwd, operation, signal) {
        if (operation.op === 'write') {
            const data = Buffer.from(operation.content);
            if (data.length > TEXT_LIMIT)
                throw new RemoteError('File exceeds the 256 KB editor limit', 413);
            return this.upload(cwd, operation.path, operation.revision, data.length, (async function* () { yield data; })(), signal);
        }
        const command = this.command(cwd, operation);
        return this.decode(this.transport.transfer
            ? (await this.transport.transfer(command, { maxBytes: 2_000_000, signal })).toString('utf8')
            : await this.transport.exec(command, operation.op === 'command' ? 130_000 : 120_000));
    }
    async download(cwd, path, revision, signal) {
        if (!this.transport.transfer)
            throw new RemoteError('File transfers are unavailable on this host', 501);
        const data = await this.transport.transfer(this.command(cwd, { op: 'download', path, revision }), { maxBytes: FILE_LIMIT, signal });
        if (createHash('sha256').update(data).digest('hex') !== revision)
            throw new RemoteError('The file changed. Reload it before saving.', 409);
        return data;
    }
    async upload(cwd, path, revision, size, input, signal) {
        if (!this.transport.transfer)
            throw new RemoteError('File transfers are unavailable on this host', 501);
        if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT)
            throw new RemoteError('File exceeds the 50 MB transfer limit', 413);
        return this.decode((await this.transport.transfer(this.command(cwd, { op: 'upload', path, revision, size }), { input, maxBytes: 16000, signal })).toString('utf8'));
    }
}
