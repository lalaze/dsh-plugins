import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { CLIENT_HEADER, H3_BATCH_LIMIT, H3_MADE, isBatchRunning, sheetHint, type BatchStatus, type BatchStatusAnswer, type GeneratedImage } from '../src/domain.js';
import { bootProgress, h3Prompt } from '../src/h3.js';
import { createHandler } from '../src/http.js';
import { apply as applyServer } from '../src/index.js';
import { AssetService } from '../src/service.js';
import { H3_PICTURE, fakeH3, type H3Call } from './fake-h3.js';

const png = (fill: number, length = 64, size = 32) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0);
  data.writeUInt32BE(0x0d0a1a0a, 4);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(size, 16);
  data.writeUInt32BE(size, 20);
  return data;
};
const gif = () => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([16, 0, 16, 0]), Buffer.alloc(20)]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>', 'utf8');

const made: string[] = [];
const services: AssetService[] = [];
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

let command = '';
let bin = '';
let calls: () => Promise<H3Call[]>;
let clearCalls: () => Promise<void>;

before(async () => {
  const fake = await fakeH3();
  made.push(...fake.dirs);
  bin = fake.bin;
  command = fake.command;
  calls = fake.calls;
  clearCalls = fake.clearCalls;
});

beforeEach(async () => {
  process.env.FAKE_H3_MODE = 'ok';
  await clearCalls();
});

after(async () => {
  for (const service of services) await service.dispose();
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function waitFor<T, S extends T>(check: () => T | Promise<T>, predicate: (value: T) => value is S, timeoutMs?: number): Promise<S>;
async function waitFor<T>(check: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs?: number): Promise<T>;
async function waitFor<T>(check: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for condition; last value: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function snapshotDir(root: string, rel = ''): Promise<Record<string, string>> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  const out: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sub = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await snapshotDir(root, sub));
    else out[sub] = (await readFile(join(root, sub))).toString('hex');
  }
  return out;
}

async function makeService(cwds: Record<string, string>, extraH3: Record<string, unknown> = {}) {
  const state = await temp('dsh-h3-settings-');
  const service = new AssetService(async id => cwds[id], join(state, 'workspaces.json'), {
    h3: { command, loginShell: false, ...extraH3 },
  });
  services.push(service);
  return service;
}

test('a batch of 5 images boots once, redraws each from its own reference, shuts down once, leaves the workspace untouched until saved, and cleans up its temp folder on discard', async () => {
  const root = await temp('dsh-h3-five-');
  await mkdir(join(root, 'art'), { recursive: true });
  const paths: string[] = [];
  const originals: Buffer[] = [];
  for (let i = 1; i <= 5; i++) {
    const rel = `art/sprite-${i}.png`;
    const bytes = png(10 + i);
    paths.push(rel);
    originals.push(bytes);
    await writeFile(join(root, rel), bytes);
  }
  const beforeFiles = await snapshotDir(root);

  const service = await makeService({ s1: root });
  await service.scan('s1');

  const started = await service.startBatch('s1', { paths, prompt: 'winter coat, keep silhouette' });
  assert.ok(started.id);
  assert.equal(started.items.length, 5);

  const finished = await waitFor(
    () => service.batchStatus('s1', started.id),
    (job): job is BatchStatus => !!job && !isBatchRunning(job.phase),
  );
  assert.equal(finished.phase, 'done');
  assert.deepEqual(finished.items.map(item => item.status), ['done', 'done', 'done', 'done', 'done']);

  const log = await calls();
  assert.deepEqual(log.map(entry => entry.sub), ['status', 'up', 'edit', 'edit', 'edit', 'edit', 'edit', 'down']);
  assert.equal(log.filter(entry => entry.sub === 'up').length, 1);
  assert.equal(log.filter(entry => entry.sub === 'down').length, 1);

  const edits = log.filter(entry => entry.sub === 'edit');
  assert.equal(edits.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(edits[i].args.slice(0, 6), ['edit', '--mp', '16', '-o', edits[i].outDir, '--json']);
    assert.equal(edits[i].prompt, '<Picture 1> winter coat, keep silhouette');
    assert.equal(edits[i].refHex, originals[i].toString('hex'), `edit ${i + 1} receives sprite-${i + 1}'s exact bytes`);
    const picture = await service.batchResult('s1', started.id, i);
    assert.deepEqual(
      [picture.source, picture.model, picture.mediaType, picture.width, picture.height, Buffer.from(picture.data, 'base64').equals(H3_PICTURE)],
      [H3_MADE.source, H3_MADE.model, 'image/png', 2048, 2048, true],
    );
  }
  assert.equal(h3Prompt('<Picture 1> keep pose'), '<Picture 1> keep pose', 'does not duplicate <Picture 1>');

  // Nothing in the workspace changed before the user saves.
  assert.deepEqual(await snapshotDir(root), beforeFiles);

  // Temp folder exists until discarded, and is deleted once discarded.
  const tempDir = dirname(edits[0].outDir!);
  assert.match(tempDir, /dsh-game-assets-h3-/);
  assert.equal(await stat(tempDir).then(() => true, () => false), true);
  await service.discardBatch('s1', started.id);
  assert.equal(await stat(tempDir).then(() => true, () => false), false, 'discard deletes the temporary directory');
  assert.equal(service.batchStatus('s1'), null);
});

test('h3 up lines are read for GPU progress; anything else is not progress', () => {
  let now = bootProgress('申请 GPU：A100 → G4 → H100（都没空就每 30 秒再试一轮，最多等 10 分钟；分配到 VM 之前不扣 CU）', {})!;
  assert.deepEqual(now, { gpus: ['A100', 'G4', 'H100'], round: 1 });
  now = bootProgress('  A100：暂时没有空闲（Service Unavailable）', now)!;
  assert.equal(now.busy, true);
  assert.equal(bootProgress('  G4：暂时没有空闲（412：临时限额，或者开着的会话太多）', now), undefined, 'still busy is no news');
  now = bootProgress('  H100：账号没有这种 GPU 的权限或配额，之后不再试', now)!;
  assert.deepEqual(now.gpus, ['A100', 'G4']);
  now = bootProgress('  第 3 轮（已等 1.0 分钟）', now)!;
  assert.deepEqual([now.round, now.waitedMinutes], [3, 1]);
  assert.equal(bootProgress('✓ 拿到 G4（第 3 轮，等了 1.0 分钟）', now)!.gpu, 'G4');
  assert.equal(bootProgress('✓ 拿到 A100', {})!.gpu, 'A100');
  assert.deepEqual(bootProgress('⚠️  和 VM 的连接断了（colab 报告连接断开（Connection was lost），之后 60 秒没有任何输出），在同一台 VM 上重新运行安装（第 2 次，已完成的步骤会跳过）', { gpu: 'A100' }), { gpu: 'A100', setupAttempt: 2 });
  for (const other of ['[colab] Creating session', '下载权重…', '']) assert.equal(bootProgress(other, now), undefined);
});

test('while h3 up waits for a free GPU the status says so, then names the GPU it got; giving up still runs down once', async () => {
  const root = await temp('dsh-h3-gpu-');
  await writeFile(join(root, 'a.png'), png(7));
  const service = await makeService({ s1: root });
  await service.scan('s1');
  process.env.FAKE_H3_MODE = 'gpu-wait';
  const started = await service.startBatch('s1', { paths: ['a.png'], prompt: 'redraw' });
  const waiting = await waitFor(() => service.batchStatus('s1', started.id), (job): job is BatchStatus => !!job?.boot?.busy);
  assert.equal(waiting.phase, 'booting');
  assert.deepEqual(waiting.boot, { gpus: ['A100'], round: 1, busy: true }, 'G4 the account may not use is dropped');
  const got = await waitFor(() => service.batchStatus('s1', started.id), (job): job is BatchStatus => !!job?.boot?.gpu);
  assert.deepEqual([got.boot!.gpu, got.boot!.round, got.boot!.waitedMinutes, typeof got.boot!.since], ['A100', 2, 0.5, 'number']);
  const done = await waitFor(() => service.batchStatus('s1', started.id), (job): job is BatchStatus => !!job && !isBatchRunning(job.phase));
  assert.equal(done.phase, 'done');
  await service.discardBatch('s1', started.id);

  await clearCalls();
  process.env.FAKE_H3_MODE = 'no-gpu';
  const second = await service.startBatch('s1', { paths: ['a.png'], prompt: 'redraw' });
  const failed = await waitFor(() => service.batchStatus('s1', second.id), (job): job is BatchStatus => !!job && !isBatchRunning(job.phase));
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error!, /^h3 could not start the VM: .*没有开机，没有扣 CU/);
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status', 'up', 'down']);
  await service.discardBatch('s1', second.id);
});

test('boot failure calls down once without drawing and marks the job failed', async () => {
  process.env.FAKE_H3_MODE = 'boot-fail';
  const root = await temp('dsh-h3-bootfail-');
  await writeFile(join(root, 'a.png'), png(1));
  await writeFile(join(root, 'b.png'), png(2));
  const service = await makeService({ s1: root });
  await service.scan('s1');

  const started = await service.startBatch('s1', { paths: ['a.png', 'b.png'], prompt: 'redraw' });
  const finished = await waitFor(
    () => service.batchStatus('s1', started.id),
    (job): job is BatchStatus => !!job && !isBatchRunning(job.phase),
  );
  assert.equal(finished.phase, 'failed');
  assert.match(finished.error ?? '', /h3 could not start the VM: Colab could not allocate an A100 runtime/);
  assert.deepEqual(finished.items.map(item => item.status), ['skipped', 'skipped']);
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status', 'up', 'down']);
  await service.discardBatch('s1', started.id);
});

test('when the 2nd image fails, it is marked failed, the remaining images still finish, and down runs once', async () => {
  process.env.FAKE_H3_MODE = 'draw-fail-2';
  const root = await temp('dsh-h3-partial-');
  await writeFile(join(root, '1.png'), png(1));
  await writeFile(join(root, '2.png'), png(2));
  await writeFile(join(root, '3.png'), png(3));
  const service = await makeService({ s1: root });
  await service.scan('s1');

  const started = await service.startBatch('s1', { paths: ['1.png', '2.png', '3.png'], prompt: 'redraw' });
  const finished = await waitFor(
    () => service.batchStatus('s1', started.id),
    (job): job is BatchStatus => !!job && !isBatchRunning(job.phase),
  );
  assert.equal(finished.phase, 'done');
  assert.deepEqual(finished.items.map(item => item.status), ['done', 'failed', 'done']);
  assert.match(finished.items[1].error ?? '', /ComfyUI workflow failed on image 2/);
  assert.equal((await service.batchResult('s1', started.id, 0)).source, 'h3');
  assert.equal((await service.batchResult('s1', started.id, 2)).source, 'h3');
  await assert.rejects(service.batchResult('s1', started.id, 1), /not ready/);

  const log = await calls();
  assert.deepEqual(log.map(entry => entry.sub), ['status', 'up', 'edit', 'edit', 'edit', 'down']);
  await service.discardBatch('s1', started.id);
});

test('stopping mid-batch kills the running child, marks waiting items skipped, calls down once, and keeps completed pictures; dispose does the same and deletes temp files', async () => {
  process.env.FAKE_H3_MODE = 'slow';
  const root = await temp('dsh-h3-stop-');
  await writeFile(join(root, '1.png'), png(1));
  await writeFile(join(root, '2.png'), png(2));
  await writeFile(join(root, '3.png'), png(3));
  const service = await makeService({ s1: root });
  await service.scan('s1');

  const started = await service.startBatch('s1', { paths: ['1.png', '2.png', '3.png'], prompt: 'redraw' });
  // Wait until picture 1 is done and picture 2's child process has started.
  await waitFor(calls, log => log.filter(entry => entry.sub === 'edit').length === 2);
  const runningLog = await calls();
  const secondEdit = runningLog.filter(entry => entry.sub === 'edit')[1];
  const childPid = secondEdit.pid;
  const subPid = secondEdit.subPid!;
  assert.ok(subPid > 0, 'stand-in h3 spawned a grandchild holding stdio pipes');

  const stopped = await service.stopBatch('s1', started.id);
  assert.equal(stopped.phase, 'stopped');
  assert.deepEqual(stopped.items.map(item => item.status), ['done', 'skipped', 'skipped']);
  const isDead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  await waitFor(() => isDead(childPid) && isDead(subPid), Boolean, 1000);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'the in-flight h3 child was killed');
  assert.throws(() => process.kill(subPid, 0), { code: 'ESRCH' }, 'its process group grandchild was killed too');

  const log = await calls();
  assert.deepEqual(log.map(entry => entry.sub), ['status', 'up', 'edit', 'edit', 'down']);

  // Picture 1 completed before stop, so its result is still available to save.
  const first = await service.batchResult('s1', started.id, 0);
  assert.equal(Buffer.from(first.data, 'base64').equals(H3_PICTURE), true);
  await service.discardBatch('s1', started.id);

  // Now verify `service.dispose()` (and Cordis `apply` cleanup) while a batch is mid-run.
  await clearCalls();
  let cleanup: (() => unknown) | undefined;
  const disposable = await makeService({ s1: root });
  await disposable.scan('s1');
  const job2 = await disposable.startBatch('s1', { paths: ['1.png', '2.png', '3.png'], prompt: 'redraw' });
  await waitFor(calls, entries => entries.filter(entry => entry.sub === 'edit').length === 2);
  const edits2 = (await calls()).filter(entry => entry.sub === 'edit');
  const tempDir2 = dirname(edits2[0].outDir!);
  const pid2 = edits2[1].pid;
  const subPid2 = edits2[1].subPid!;

  await disposable.dispose();
  await waitFor(() => isDead(pid2) && isDead(subPid2), Boolean, 1000);
  assert.throws(() => process.kill(pid2, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(subPid2, 0), { code: 'ESRCH' });
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status', 'up', 'edit', 'edit', 'down']);
  assert.equal(await stat(tempDir2).then(() => true, () => false), false, 'dispose removes temporary directories');
  assert.ok(job2.id);

  // Verify `apply(ctx)` registers an effect disposer.
  applyServer({
    get: () => undefined,
    effect: (fn: () => () => unknown) => { cleanup = fn(); },
    connection: { fetch: { register: () => {} } },
  } as never);
  assert.equal(typeof cleanup, 'function');
  await cleanup!();
});

test('startBatch returns before boot finishes, reconnects the same session, refuses a second session with 409, and refuses already-up VM with 409 without calling up or down', async () => {
  const root1 = await temp('dsh-h3-s1-');
  const root2 = await temp('dsh-h3-s2-');
  await writeFile(join(root1, 'a.png'), png(1));
  await writeFile(join(root2, 'b.png'), png(2));
  const service = await makeService({ s1: root1, s2: root2 });
  await service.scan('s1');
  await service.scan('s2');

  // 1. VM already running (`already-up`): 409, and neither `up` nor `down` is called.
  process.env.FAKE_H3_MODE = 'already-up';
  await assert.rejects(
    service.startBatch('s1', { paths: ['a.png'], prompt: 'redraw' }),
    (err: Error & { status?: number }) => err.status === 409 && /already running/.test(err.message),
  );
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status']);

  // 2. While `s1` is booting (`slow-boot`), `startBatch` has already returned its job id; `s1` reconnects and `s2` gets 409.
  await clearCalls();
  process.env.FAKE_H3_MODE = 'slow-boot';
  const started = await service.startBatch('s1', { paths: ['a.png'], prompt: 'redraw' });
  assert.equal(started.phase, 'booting');
  await waitFor(calls, log => log.some(entry => entry.sub === 'up'));
  assert.equal((await calls()).some(entry => entry.sub === 'down'), false, 'boot is still in progress when startBatch returned');

  const reconnected = await service.startBatch('s1', { paths: ['a.png'], prompt: 'redraw' });
  assert.equal(reconnected.id, started.id, 'same session gets the running job id back');

  await assert.rejects(
    service.startBatch('s2', { paths: ['b.png'], prompt: 'redraw' }),
    (err: Error & { status?: number }) => err.status === 409 && /another workspace/.test(err.message),
  );
  assert.equal(service.batchBusy('s2'), true);
  assert.equal(service.batchBusy('s1'), false);
  assert.equal((await calls()).filter(entry => entry.sub === 'up').length, 1, 'no second VM boot was started');

  // HTTP routes report busy and handle start/status/result/stop/discard.
  const handler = createHandler(service);
  const post = async (body: Record<string, unknown>) => {
    const res = await handler(new Request('http://dsh.test/api/game-assets', {
      method: 'POST',
      headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json() };
  };
  const s2Status = await post({ action: 'h3Status', sessionId: 's2' });
  assert.deepEqual(s2Status, { status: 200, json: { job: null, busy: true } satisfies BatchStatusAnswer });

  const stopped = await post({ action: 'h3Stop', sessionId: 's1', id: started.id });
  assert.equal(stopped.status, 200);
  assert.equal((stopped.json as BatchStatus).phase, 'stopped');
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status', 'up', 'down']);

  const discarded = await post({ action: 'h3Discard', sessionId: 's1', id: started.id });
  assert.deepEqual(discarded, { status: 200, json: { ok: true } });
});

test('GIF and see-through images go as the sheets the page made: h3 gets those bytes and the sheet hint, the status carries the layout, other images go as they are', async () => {
  const root = await temp('dsh-h3-sheets-');
  await writeFile(join(root, 'walk.gif'), gif());
  await writeFile(join(root, 'ghost.png'), png(40));
  await writeFile(join(root, 'wall.png'), png(41));
  const service = await makeService({ s1: root });
  await service.scan('s1');
  const walkSheet = { key: '#0000ff', bands: 3, gutter: 11 }, ghostSheet = { key: '#00ff00', bands: 1, gutter: 0 };
  const walkRef = png(50, 80), ghostRef = png(51, 72);
  const started = await service.startBatch('s1', {
    paths: ['walk.gif', 'ghost.png', 'wall.png'],
    prompt: 'snowy winter outfit',
    prepared: { 'walk.gif': { data: walkRef.toString('base64'), sheet: walkSheet }, 'ghost.png': { data: ghostRef.toString('base64'), sheet: ghostSheet } },
  });
  assert.deepEqual(started.items.map(item => item.sheet), [walkSheet, ghostSheet, undefined]);
  const done = await waitFor(() => service.batchStatus('s1', started.id), (job): job is BatchStatus => !!job && !isBatchRunning(job.phase));
  assert.deepEqual(done.items.map(item => [item.status, item.sheet?.bands]), [['done', 3], ['done', 1], ['done', undefined]]);
  const edits = (await calls()).filter(entry => entry.sub === 'edit');
  assert.deepEqual(edits.map(entry => entry.refHex), [walkRef.toString('hex'), ghostRef.toString('hex'), png(41).toString('hex')]);
  assert.match(edits[0].reference!, /\.png$/, 'a GIF\'s sheet is staged under a .png name');
  assert.equal(edits[0].prompt, `<Picture 1> snowy winter outfit\n\n${sheetHint(walkSheet)}`);
  assert.match(edits[0].prompt!, /flat #0000ff background.*The 3 rows are separate strips/s);
  assert.equal(edits[1].prompt, `<Picture 1> snowy winter outfit\n\n${sheetHint(ghostSheet)}`);
  assert.doesNotMatch(edits[1].prompt!, /rows are separate/);
  assert.equal(edits[2].prompt, '<Picture 1> snowy winter outfit');
  await service.discardBatch('s1', started.id);
});

test('invalid batch requests (over 20 images, unlisted paths, retired images, GIF/SVG, empty prompt) and missing h3 are rejected with clear reasons and never boot a VM', async () => {
  const root = await temp('dsh-h3-invalid-');
  for (let i = 0; i <= H3_BATCH_LIMIT; i++) await writeFile(join(root, `p-${i}.png`), png(i + 1));
  await writeFile(join(root, 'anim.gif'), gif());
  await writeFile(join(root, 'icon.svg'), svg());
  await writeFile(join(root, 'retire-me.png'), png(99));

  const service = await makeService({ s1: root });
  await service.scan('s1');
  await service.retire('s1', ['retire-me.png']);

  const tooMany = Array.from({ length: H3_BATCH_LIMIT + 1 }, (_, i) => `p-${i}.png`);
  await assert.rejects(service.startBatch('s1', { paths: tooMany, prompt: 'redraw' }), /Up to 20 images/);
  await assert.rejects(service.startBatch('s1', { paths: ['missing.png'], prompt: 'redraw' }), /Not an image of this workspace/);
  await assert.rejects(service.startBatch('s1', { paths: ['_retired/retire-me.png'], prompt: 'redraw' }), /Retired images cannot be redrawn/);
  await assert.rejects(service.startBatch('s1', { paths: ['anim.gif'], prompt: 'redraw' }), /anim\.gif must be sent as a PNG sprite sheet/);
  await assert.rejects(service.startBatch('s1', { paths: ['icon.svg'], prompt: 'redraw' }), /Only PNG, WebP, JPEG and GIF/);
  await assert.rejects(service.startBatch('s1', { paths: ['p-0.png'], prompt: '   ' }), /Describe the picture/);
  const sheet = { key: '#ff00ff', bands: 1, gutter: 0 }, data = png(5).toString('base64');
  await assert.rejects(service.startBatch('s1', { paths: ['anim.gif'], prompt: 'redraw', prepared: [] }), /Invalid sprite sheets/);
  await assert.rejects(service.startBatch('s1', { paths: ['anim.gif'], prompt: 'redraw', prepared: { 'p-0.png': { data, sheet } } }), /names an image outside the selection/);
  for (const bad of [{ data, sheet: { ...sheet, key: 'magenta' } }, { data, sheet: { ...sheet, bands: 0 } }, { data, sheet: { ...sheet, gutter: 1.5 } }, { data: '', sheet }, { sheet }]) {
    await assert.rejects(service.startBatch('s1', { paths: ['anim.gif'], prompt: 'redraw', prepared: { 'anim.gif': bad } }), /Invalid sprite sheet for anim\.gif/, JSON.stringify(bad));
  }
  assert.deepEqual(await calls(), [], 'none of the invalid requests invoked h3');
  // A sheet that is not a PNG is found only once staging begins, after `h3 status` and before any boot.
  await assert.rejects(service.startBatch('s1', { paths: ['anim.gif'], prompt: 'redraw', prepared: { 'anim.gif': { data: gif().toString('base64'), sheet } } }), /The sheet made from anim\.gif is not a PNG/);
  assert.deepEqual((await calls()).map(entry => entry.sub), ['status']);
  await clearCalls();

  // Missing h3 executable reports a clear error without calling up or down.
  const missing = await makeService({ s1: root }, { command: join(bin, 'no-such-h3'), loginShell: false });
  await missing.scan('s1');
  await assert.rejects(missing.startBatch('s1', { paths: ['p-0.png'], prompt: 'redraw' }), /h3 was not found on this machine/);

  // Login shell mode preserves prompts with single quotes and records downError if `h3 down` fails.
  process.env.FAKE_H3_MODE = 'down-fail';
  const shell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  try {
    const viaShell = await makeService({ s1: root }, { command, loginShell: true });
    await viaShell.scan('s1');
    const job = await viaShell.startBatch('s1', { paths: ['p-0.png'], prompt: "hero's 'shield'" });
    const done = await waitFor(
      () => viaShell.batchStatus('s1', job.id),
      (current): current is BatchStatus => !!current && !isBatchRunning(current.phase),
    );
    assert.equal(done.phase, 'done');
    assert.match(done.downError ?? '', /h3 down failed; run h3 down yourself/);
    assert.equal((await calls()).find(entry => entry.sub === 'edit')?.prompt, "<Picture 1> hero's 'shield'");
    const handler = createHandler(viaShell);
    const res = await handler(new Request('http://dsh.test/api/game-assets', {
      method: 'POST',
      headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'h3Result', sessionId: 's1', id: job.id, index: 0 }),
    }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as GeneratedImage).source, 'h3');
    await viaShell.discardBatch('s1', job.id);
  } finally {
    process.env.SHELL = shell;
  }
});
