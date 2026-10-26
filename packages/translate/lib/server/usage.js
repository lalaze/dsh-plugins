import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function translationUsageRoot(env = process.env, home = homedir()) {
    return env.DSH_TRANSLATE_USAGE_DIR?.trim() || join(env.DSH_HOME || join(home, '.dsh'), 'storages', 'dsh-translate', 'usage');
}
function count(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function parseUsage(payload) {
    const usage = payload && typeof payload === 'object' ? payload.usage : undefined;
    if (!usage || typeof usage !== 'object')
        return null;
    const record = usage;
    const input = count(record.prompt_tokens ?? record.input_tokens), output = count(record.completion_tokens ?? record.output_tokens);
    if (input === null || output === null || !Number.isSafeInteger(input + output))
        return null;
    const prompt = record.prompt_tokens_details;
    const completion = record.completion_tokens_details;
    const cacheRead = Math.min(count(prompt?.cached_tokens) ?? 0, input);
    const reasoning = count(completion?.reasoning_tokens);
    return { input, output, cacheRead, cacheWrite: 0, reasoning: reasoning !== null && reasoning <= output ? reasoning : null };
}
export function createUsageLedger(root = translationUsageRoot()) {
    let queue = Promise.resolve();
    return { record(entry) { queue = queue.then(async () => { await mkdir(root, { recursive: true }); await appendFile(join(root, `${entry.at.slice(0, 7)}.jsonl`), `${JSON.stringify({ v: 1, ...entry })}\n`, { encoding: 'utf8', mode: 0o600 }); }).catch(() => { }); return queue; } };
}
