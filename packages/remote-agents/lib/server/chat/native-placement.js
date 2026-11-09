import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { RemoteError } from '../core/domain.js';
function key(value, name) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value))
        throw new RemoteError(`Invalid ${name}`);
}
/** No expansion, directory guessing, mkdir, file copying or credential access. */
export function nativeLocalDirectory(path) {
    key(path, 'local directory');
    if (!isAbsolute(path))
        throw new RemoteError('Local directory must be absolute');
    try {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory())
            throw new Error('not a directory');
        return canonical;
    }
    catch {
        throw new RemoteError('Local directory must be an existing directory', 409);
    }
}
/** Machine-local consent, stored separately from the shared history and replica journal. */
export class NativePlacements {
    path;
    mappings;
    constructor(path) {
        this.path = path;
        const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, mappings: [] };
        if (state.schema !== 1 || !Array.isArray(state.mappings))
            throw new Error('Unsupported native project mappings; preserve the file for recovery');
        this.mappings = state.mappings;
        for (const mapping of this.mappings) {
            key(mapping.hostId, 'host ID');
            key(mapping.projectKey, 'project key');
            key(mapping.localDirectory, 'local directory');
            if (!isAbsolute(mapping.localDirectory))
                throw new Error('Invalid saved native project mapping');
        }
    }
    list(hostId) { return structuredClone(this.mappings.filter(m => m.hostId === hostId)); }
    get(hostId, projectKey) { return this.list(hostId).find(m => m.projectKey === projectKey); }
    receiver(hostId, projectKey) {
        const mapping = this.get(hostId, projectKey);
        if (!mapping)
            throw new RemoteError('Project mapping required: confirm a local directory for this source project', 409);
        if (nativeLocalDirectory(mapping.localDirectory) !== mapping.localDirectory)
            throw new RemoteError('Mapped directory changed; confirm the project mapping again', 409);
        return { kind: 'local', project: projectKey, localDirectory: mapping.localDirectory };
    }
    source(hostId, cwd) {
        const directory = nativeLocalDirectory(cwd);
        const matches = this.list(hostId).filter(m => m.localDirectory === directory);
        if (matches.length !== 1)
            throw new RemoteError('Project mapping required: map this local directory to exactly one source project before sharing', 409);
        return matches[0].projectKey;
    }
    set(hostId, projectKey, localDirectory, confirmedDirectory) {
        key(hostId, 'host ID');
        key(projectKey, 'project key');
        if (!projectKey.startsWith('/'))
            throw new RemoteError('Source project key must be an absolute source project path');
        const canonical = nativeLocalDirectory(localDirectory);
        if (confirmedDirectory !== canonical)
            throw new RemoteError('Confirm the exact canonical local directory before saving the project mapping', 409);
        const next = { hostId, projectKey, localDirectory: canonical };
        if (this.list(hostId).some(m => m.projectKey !== projectKey && m.localDirectory === canonical))
            throw new RemoteError('This local directory is already mapped to another source project', 409);
        const mappings = [...this.mappings.filter(m => m.hostId !== hostId || m.projectKey !== projectKey), next];
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            const fd = openSync(temporary, 'wx', 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ schema: 1, mappings }));
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(temporary, this.path);
            this.mappings = mappings;
            const dir = openSync(dirname(this.path), 'r');
            try {
                fsyncSync(dir);
            }
            finally {
                closeSync(dir);
            }
        }
        finally {
            if (existsSync(temporary))
                unlinkSync(temporary);
        }
        return { ...next };
    }
}
