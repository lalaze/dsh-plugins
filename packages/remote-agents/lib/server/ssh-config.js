import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { connectionInput } from './ssh.js';
const MAX_FILES = 64, MAX_BYTES = 1_048_576, MAX_HOSTS = 512, MAX_DEPTH = 16;
const LIMIT_WARNING = 'SSH config is too large to list completely. Enter a missing alias manually.';
/** Only tokenize declarations. Never evaluate Match exec, ProxyCommand, or run ssh -G. */
function words(value) {
    const result = [];
    let word = '', quoted = false, escaped = false, started = false;
    for (const char of value) {
        if (escaped) {
            word += char;
            escaped = false;
            started = true;
        }
        else if (char === '\\') {
            escaped = true;
            started = true;
        }
        else if (char === '"') {
            quoted = !quoted;
            started = true;
        }
        else if (char === '#' && !quoted)
            break;
        else if (/\s/.test(char) && !quoted) {
            if (started)
                result.push(word);
            word = '';
            started = false;
        }
        else {
            word += char;
            started = true;
        }
    }
    if (quoted || escaped)
        return [];
    if (started)
        result.push(word);
    return result;
}
function matches(alias, pattern) {
    const source = [...pattern].map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('');
    return new RegExp(`^${source}$`).test(alias);
}
/** List concrete Host aliases; OpenSSH remains responsible for the effective connection options. */
export async function readSshConfigHosts(options = {}) {
    const home = options.home ?? homedir(), environment = options.environment ?? process.env;
    const userConfig = join(home, '.ssh', 'config');
    const systemConfig = options.systemConfig ?? (process.platform === 'win32' ? join(environment.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config');
    const hosts = new Map(), warnings = new Set(), visited = new Set();
    let bytes = 0;
    function includePath(value, base) {
        let unresolved = false;
        value = value.replace(/\$\{([^}]+)\}/g, (_, name) => {
            const expanded = environment[name];
            if (expanded === undefined)
                unresolved = true;
            return expanded ?? '';
        }).replace(/%%|%[a-zA-Z]/g, token => {
            if (token === '%%')
                return '%';
            if (token === '%d')
                return home;
            unresolved = true;
            return '';
        });
        if (value === '~')
            value = home;
        else if (value.startsWith('~/'))
            value = join(home, value.slice(2));
        else if (value.startsWith('~'))
            unresolved = true;
        if (unresolved) {
            warnings.add('Some SSH Include paths need a user or connection context. Enter missing aliases manually.');
            return;
        }
        return isAbsolute(value) ? value : resolve(base, value);
    }
    async function visit(file, base, depth) {
        if (depth > MAX_DEPTH || visited.size >= MAX_FILES) {
            warnings.add(LIMIT_WARNING);
            return;
        }
        try {
            const canonical = await realpath(file);
            if (visited.has(canonical))
                return;
            const info = await stat(canonical);
            if (!info.isFile())
                return;
            visited.add(canonical);
            if (info.size > MAX_BYTES - bytes) {
                warnings.add(LIMIT_WARNING);
                return;
            }
            const text = await readFile(canonical, 'utf8');
            bytes += Buffer.byteLength(text);
            if (bytes > MAX_BYTES) {
                warnings.add(LIMIT_WARNING);
                return;
            }
            for (const line of text.split(/\r?\n/)) {
                const declaration = /^\s*([a-z]+)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
                if (!declaration)
                    continue;
                const keyword = declaration[1].toLowerCase(), values = words(declaration[2]);
                if (keyword === 'host') {
                    for (const alias of values) {
                        if (!alias || /[!*?@/]/.test(alias) || values.some(value => value.startsWith('!') && matches(alias, value.slice(1))))
                            continue;
                        try {
                            const connection = connectionInput(isIP(alias) === 6 ? `[${alias}]` : alias);
                            if (hosts.size >= MAX_HOSTS && !hosts.has(alias)) {
                                warnings.add(LIMIT_WARNING);
                                continue;
                            }
                            hosts.set(alias, connection);
                        }
                        catch { /* Host patterns and names unsupported by the connection form are not selectable. */ }
                    }
                }
                else if (keyword === 'include') {
                    for (const value of values) {
                        const pattern = includePath(value, base);
                        if (!pattern)
                            continue;
                        const files = [];
                        for await (const path of glob(pattern)) {
                            if (files.length >= MAX_FILES) {
                                warnings.add(LIMIT_WARNING);
                                break;
                            }
                            files.push(path);
                        }
                        for (const path of files.sort())
                            await visit(path, base, depth + 1);
                    }
                }
            }
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                warnings.add(`Could not read SSH config (${code ?? 'unknown error'}). Check file permissions.`);
        }
    }
    // Includes in user/system configuration are relative to ~/.ssh and /etc/ssh respectively.
    await visit(userConfig, dirname(userConfig), 0);
    await visit(systemConfig, dirname(systemConfig), 0);
    return { hosts: [...hosts].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([alias, connection]) => ({ alias, connection })), warnings: [...warnings] };
}
