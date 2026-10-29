import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';

/**
 * dsh-remote-agents 0.2.53 and earlier stored a remote CLI row's tool/call when its first tool started, but the
 * assistant/message advertising it only when the response ended (or never, when DSH quit mid-response). DSH refuses
 * to reopen such a log: "tool/call remote-1-1-cli has no advertised tool lifecycle". Each such log is repaired once:
 * the advertising message moves ahead of its call (or is added when missing) and every event reference follows.
 * An interrupted response stays an open turn, which DSH closes itself when the conversation reopens.
 */
export interface Row { type: string; seq: number; time: number; data?: any; surfaceOp?: unknown; sourceEventSeqs?: number[]; [key: string]: unknown }

const ROOT_CALL = /^remote-\d+-\d+-cli$/;
const LOGS = ['session.v4.jsonl.zstd', 'session.v4.jsonl'];
const compress = promisify(zstdCompress), decompress = promisify(zstdDecompress);

const toolCalls = (row: Row): string[] => row.type === 'assistant/message' && Array.isArray(row.data?.message?.content)
  ? row.data.message.content.filter((b: any) => b?.type === 'tool-call' && typeof b.id === 'string').map((b: any) => b.id as string) : [];

/** The message 0.2.53 would have written when the response ended, attributed to the conversation's last model. */
function advertisement(call: Row, before: Row[]): Row {
  const config = before.findLast(r => r.type === 'request/header')?.data?.header?.config, named = (value: unknown) => typeof value === 'string' && value ? value : 'remote-cli';
  const { turn, step, callId, name, arguments: args } = call.data;
  return { type: 'assistant/message', seq: -1, time: call.time, data: { turn, step, message: {
    id: `${callId}:call`, role: 'assistant', source: { kind: 'model', provider: named(config?.provider), model: named(config?.model) },
    content: [{ type: 'tool-call', id: callId, name, arguments: args }],
  }, stream: [] }, surfaceOp: 'append' };
}

/**
 * Put each remote CLI row's advertising message directly before its tool/call and renumber the log.
 * @returns the repaired rows, or undefined when the log needs no repair.
 */
export function repairRows(rows: Row[]): Row[] | undefined {
  const out = [...rows];
  let advertised = new Set<string>(), changed = false;
  for (let i = 0; i < out.length; i++) {
    const row = out[i]!;
    if (row.type === 'turn/start') advertised = new Set();
    for (const id of toolCalls(row)) advertised.add(id);
    const id = row.type === 'tool/call' ? row.data?.callId : undefined;
    if (typeof id !== 'string' || !ROOT_CALL.test(id) || advertised.has(id)) continue;
    let j = i + 1;
    while (j < out.length && out[j]!.type !== 'turn/start' && !toolCalls(out[j]!).includes(id)) j++;
    const message = toolCalls(out[j] ?? { type: '', seq: -1, time: 0 }).includes(id) ? out.splice(j, 1)[0]! : advertisement(row, out.slice(0, i));
    // Event times stay non-decreasing: the moved message takes its call's time.
    out.splice(i, 0, { ...message, time: Math.min(message.time, row.time) });
    advertised.add(id); changed = true;
  }
  if (!changed) return;
  // Rows keep their old seq until renumbered; an added message has none.
  const base = rows[0]!.seq, moved = new Map<number, number>();
  out.forEach((row, index) => { if (row.seq >= 0) moved.set(row.seq, base + index); });
  const seq = (value: unknown) => typeof value === 'number' ? moved.get(value) ?? value : value;
  const seqs = (value: unknown) => Array.isArray(value) ? value.map(seq) : value;
  // A delivery watermark covers a prefix: it now ends before the first row it did not cover.
  const through = (value: unknown) => {
    if (typeof value !== 'number') return value;
    const first = out.findIndex(r => r.seq < 0 || r.seq > value);
    return first < 0 ? base + out.length - 1 : Math.max(base + first - 1, 0);
  };
  // The event references DSH's own v3→v4 migration remaps, plus the developer header and delivery watermark.
  return out.map((row, index) => {
    const next: Row = { ...row, seq: base + index };
    if (row.sourceEventSeqs) next.sourceEventSeqs = seqs(row.sourceEventSeqs) as number[];
    if (row.surfaceOp && typeof row.surfaceOp === 'object') {
      const op = row.surfaceOp as Record<string, unknown>;
      next.surfaceOp = { ...op, startSeq: seq(op.startSeq), endSeq: seq(op.endSeq) };
    }
    const data = row.data && typeof row.data === 'object' ? { ...row.data } : undefined;
    if (!data) return next;
    switch (row.type) {
      case 'command/done': if (data.sourceEventSeq !== undefined) data.sourceEventSeq = seq(data.sourceEventSeq); break;
      case 'developer/message': if (data.headerSeq !== undefined) data.headerSeq = seq(data.headerSeq); break;
      case 'compaction/summary': case 'compaction/prune':
        data.shadowedSeqs = seqs(data.shadowedSeqs);
        if (data.shadowedRange && typeof data.shadowedRange === 'object') data.shadowedRange = { ...data.shadowedRange, start: seq(data.shadowedRange.start), end: seq(data.shadowedRange.end) };
        break;
      case 'session/title': case 'session/title-llm-request': data.messageSeqs = seqs(data.messageSeqs); break;
      case 'image/offload': if (Array.isArray(data.targets)) data.targets = data.targets.map((t: any) => t && typeof t === 'object' ? { ...t, seq: seq(t.seq) } : t); break;
      case 'session-log-deepseek/delivery-accepted': data.throughSeq = through(data.throughSeq); break;
      default: return next;
    }
    return { ...next, data };
  });
}

/** Split a concatenated Zstandard log into complete frames and a torn final frame; undefined for a foreign file. */
export function zstdFrames(buffer: Buffer): { frames: Buffer[]; torn?: Buffer } | undefined {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < buffer.length;) {
    const start = offset, torn = () => ({ frames, torn: buffer.subarray(start) });
    if (buffer.length - offset < 5) return torn();
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return;
    const descriptor = buffer.readUInt8(offset + 4), single = (descriptor & 32) !== 0, dictionary = descriptor & 3, size = descriptor >>> 6;
    offset += 5 + (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (size === 0 ? (single ? 1 : 0) : 1 << size);
    for (let last = false; !last;) {
      if (buffer.length - offset < 3) return torn();
      const block = buffer.readUIntLE(offset, 3), type = (block >>> 1) & 3;
      if (type === 3) return;
      last = (block & 1) !== 0; offset += 3 + (type === 1 ? 1 : block >>> 3);
    }
    if (descriptor & 4) offset += 4;
    if (offset > buffer.length) return torn();
    frames.push(buffer.subarray(start, offset));
  }
  return { frames };
}

/**
 * Repair one stored DSH log in place, keeping the original under `backupDir`.
 * @param skip - session ids DSH has open; their logs are left alone.
 * @returns 'repaired', 'skipped' for an open session, or undefined when the log needs no repair.
 */
export async function repairSessionLog(path: string, backupDir: string, skip: (id: string) => boolean = () => false): Promise<'repaired' | 'skipped' | undefined> {
  const before = await stat(path), raw = await readFile(path), zstd = path.endsWith('.zstd');
  let header: Buffer, headerText: string, body: string;
  try {
    if (zstd) {
      const split = zstdFrames(raw), first = split?.frames[0];
      if (!split || !first) return;
      header = first; headerText = (await decompress(header)).toString('utf8');
      body = (await Promise.all(split.frames.slice(1).map(f => decompress(f)))).map(b => b.toString('utf8')).join('');
      if (split.torn) body += (await decompress(split.torn, { finishFlush: constants.ZSTD_e_flush }).catch(() => Buffer.alloc(0))).toString('utf8');
    } else {
      const end = raw.indexOf(10);
      if (end < 0) return;
      header = raw.subarray(0, end + 1); headerText = header.toString('utf8'); body = raw.subarray(end + 1).toString('utf8');
    }
  } catch { return; }
  // Like DSH's reader, keep a torn tail's complete lines; the rewritten log then has no torn tail.
  body = body.slice(0, body.lastIndexOf('\n') + 1);
  if (!body.includes('"callId":"remote-')) return;
  let id: unknown, rows: Row[];
  try { id = JSON.parse(headerText).id; rows = body.slice(0, -1).split('\n').map(line => JSON.parse(line) as Row); }
  catch { return; }
  const repaired = repairRows(rows);
  if (!repaired || typeof id !== 'string') return;
  if (skip(id)) return 'skipped';
  const text = Buffer.from(repaired.map(row => `${JSON.stringify(row)}\n`).join(''));
  const content = Buffer.concat([header, zstd ? await compress(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }) : text]);
  const [dir, file] = path.split(/[\\/]/).slice(-2);
  await mkdir(backupDir, { recursive: true });
  await copyFile(path, join(backupDir, `${dir}-${file}`));
  // DSH ignores `<log>.<hex>.tmp` names.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`, handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  const now = await stat(path);
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) { await rm(tmp, { force: true }); return 'skipped'; }
  await rename(tmp, path);
  return 'repaired';
}

/**
 * Repair every stored DSH log written in the old order. Runs until one pass leaves nothing skipped, then never again.
 * @param root - DSH's session root (`<project>/<session>/session.v4.jsonl.zstd`).
 * @param stateDir - this plugin's state directory: holds the completion marker and the original logs.
 * @param skip - session ids DSH has open.
 * @returns the repaired log paths.
 */
export async function repairStoredSessions(root: string, stateDir: string, skip?: (id: string) => boolean): Promise<string[]> {
  const marker = join(stateDir, 'session-repair.json');
  try { await stat(marker); return []; } catch {}
  const repaired: string[] = [], backups = join(stateDir, 'session-backups');
  let skipped = false;
  const entries = async (dir: string) => { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } };
  for (const project of await entries(root)) {
    if (!project.isDirectory()) continue;
    for (const session of await entries(join(root, project.name))) {
      if (!session.isDirectory()) continue;
      for (const name of LOGS) {
        const path = join(root, project.name, session.name, name);
        let result: Awaited<ReturnType<typeof repairSessionLog>>;
        try { result = await repairSessionLog(path, backups, skip); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (result === 'repaired') repaired.push(path);
        else if (result === 'skipped') skipped = true;
      }
    }
  }
  if (!skipped) { await mkdir(stateDir, { recursive: true }); await writeFile(marker, `${JSON.stringify({ version: 1, repaired })}\n`); }
  return repaired;
}
