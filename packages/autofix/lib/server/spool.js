/** In the account's own folder on that machine; its mode keeps other accounts out. */
export const SPOOL_ROOT = '$HOME/.dsh-autofix';
const SAFE = /^[\w.%@:-]+(?:\/[\w.%@:-]+)*$/u;
const OPEN = '@@AF<', CLOSE = '>AF@@';
/** Base64 characters per command: far below the smallest limit on a command line's length. */
const CHUNK = 48_000;
const TIMEOUT = 45_000;
/** A task's key as a file name. */
export const fileName = (key) => encodeURIComponent(key);
/** What the shell printed between the marks: a login banner or a warning around it does not matter. */
function between(out) {
    const start = out.lastIndexOf(OPEN), end = out.indexOf(CLOSE, start);
    return start < 0 || end < 0 ? undefined : out.slice(start + OPEN.length, end);
}
export class Spool {
    machine;
    root;
    constructor(machine, root = SPOOL_ROOT) {
        this.machine = machine;
        this.root = root;
    }
    /** Quoted for the shell; only names this code makes itself get here. */
    path(relative) {
        if (!SAFE.test(relative) || relative.split('/').includes('..'))
            throw new Error('Not a path in the shared folder');
        return `"${this.root}/${relative}"`;
    }
    async sh(script, signal) {
        let out = '';
        const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
        const code = await this.machine.shell(`umask 077; ${script}`, {}, text => { out += text; }, stop);
        if (code !== 0)
            throw new Error(`The machine refused: ${out.trim().slice(-300) || `exit ${code}`}`);
        return out;
    }
    /** A file's bytes; undefined when it is not there. */
    async read(relative, signal) {
        const file = this.path(relative);
        const body = between(await this.sh(`if [ -f ${file} ]; then printf '${OPEN}'; base64 < ${file} | tr -d '\\n'; printf '${CLOSE}'; else printf '${OPEN}-${CLOSE}'; fi`, signal));
        if (body === undefined)
            throw new Error('The machine did not answer as expected');
        return body === '-' ? undefined : Buffer.from(body, 'base64');
    }
    async readJson(relative, signal) {
        const bytes = await this.read(relative, signal);
        if (!bytes)
            return undefined;
        try {
            return JSON.parse(bytes.toString('utf8'));
        }
        catch {
            return undefined;
        }
    }
    /** Whole or not at all: a reader never sees half a file. */
    async write(relative, data, signal) {
        const file = this.path(relative), part = this.path(`${relative}.part`), encoded = Buffer.from(data).toString('base64');
        if (encoded.length <= CHUNK) {
            await this.sh(`mkdir -p "$(dirname ${file})" && printf %s '${encoded}' | base64 --decode > ${part} && mv ${part} ${file}`, signal);
            return;
        }
        const text = this.path(`${relative}.b64`);
        await this.sh(`mkdir -p "$(dirname ${file})" && : > ${text}`, signal);
        for (let at = 0; at < encoded.length; at += CHUNK)
            await this.sh(`printf %s '${encoded.slice(at, at + CHUNK)}' >> ${text}`, signal);
        await this.sh(`base64 --decode < ${text} > ${part} && mv ${part} ${file}; status=$?; rm -f ${text}; exit $status`, signal);
    }
    writeJson(relative, value, signal) { return this.write(relative, JSON.stringify(value), signal); }
    /** A file, or a folder with what is in it. */
    async remove(relative, signal) { await this.sh(`rm -rf ${this.path(relative)}`, signal); }
    /** Every *.json in a folder with its text, in one round trip; then what is older than a day in `sweep` is cleared. */
    async collect(folder, sweep, signal) {
        const dir = this.path(folder), old = sweep ? `; find ${this.path(sweep)} -type f -mtime +1 -delete 2>/dev/null` : '';
        const body = between(await this.sh(`printf '${OPEN}'; if [ -d ${dir} ]; then for f in ${dir}/*.json; do [ -f "$f" ] || continue; printf '%s:' "$(basename "$f" .json)"; base64 < "$f" | tr -d '\\n'; printf '\\n'; done; fi; printf '${CLOSE}'${old}; true`, signal));
        if (body === undefined)
            throw new Error('The machine did not answer as expected');
        return body.split('\n').filter(Boolean).flatMap(line => {
            const at = line.indexOf(':');
            return at > 0 ? [{ name: line.slice(0, at), text: Buffer.from(line.slice(at + 1), 'base64').toString('utf8') }] : [];
        });
    }
}
