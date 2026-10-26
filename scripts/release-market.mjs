// Publish built plugins to the `market` branch and update the DSH plugin market index on it.
// Usage: pnpm release:market [--dry-run]
// The branch is append-only: every listed version pins one of its commits, so never rewrite or force-push it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_INLINE_ICON_BYTES, marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const BRANCH = 'market';
const SOURCE_FILES = ['packages', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
const GENERIC_KEYWORDS = new Set(['dsh-plugin', 'deepseek-harness']);
const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const root = fileURLToPath(new URL('../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const run = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (args, cwd = root) => run('git', args, cwd);
const succeeds = (args, cwd = root) => { try { git(args, cwd); return true; } catch { return false; } };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = message => { console.error(message); process.exit(1); };

// Display text comes from what the repository already maintains: README headings and the root plugin tables.
const heading = async path => existsSync(path) ? /^# (.+)$/m.exec(await readFile(path, 'utf8'))?.[1].trim() : undefined;
const tableRows = text => [...text.matchAll(/^\| `([^`]+)` \| [^|]+ \| (.+?) \|$/gm)].map(([, name, description]) => [name, description]);
const localized = (en, zh) => zh && zh !== en ? { en, zh } : en;

async function digest(dir) {
  if (!existsSync(dir)) return '';
  const hash = createHash('sha256');
  const walk = async (path, prefix) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${relative}/`);
      else hash.update(relative).update('\0').update(await readFile(join(path, entry.name))).update('\0');
    }
  };
  await walk(dir, '');
  return hash.digest('hex');
}

async function inlineIcon(dir, manifest) {
  if (typeof manifest.icon !== 'string') return undefined;
  const type = ICON_TYPES[extname(manifest.icon).toLowerCase()], path = join(dir, manifest.icon);
  if (!type || !existsSync(path)) return undefined;
  const bytes = await readFile(path);
  return bytes.length <= MAX_INLINE_ICON_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : undefined;
}

const rootManifest = await readJson(join(root, 'package.json'));
const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(rootManifest.repository?.url ?? '');
if (!github) fail('The root package.json repository.url must name a GitHub repository.');
const [, owner, repo] = github;
const repoUrl = `https://github.com/${owner}/${repo}`;
const indexUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${BRANCH}/index.json`;
const sourceBranch = (() => { try { return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch { return 'main'; } })();

const dirty = git(['status', '--porcelain', '--', ...SOURCE_FILES]);
if (dirty && !dryRun) fail(`Commit or stash these changes first, so the release matches a commit:\n${dirty}`);
if (dirty) console.warn('Dry run with uncommitted changes; a real release requires a clean tree.\n');
const sourceCommit = git(['rev-parse', 'HEAD']);
if (succeeds(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`])
  && succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`])
  && !succeeds(['merge-base', '--is-ancestor', `origin/${BRANCH}`, BRANCH])) {
  fail(`Local ${BRANCH} does not contain origin/${BRANCH}. Update it first: git fetch origin && git branch -f ${BRANCH} origin/${BRANCH}`);
}

const readme = { en: await readFile(join(root, 'README.md'), 'utf8'), zh: await readFile(join(root, 'README.zh-CN.md'), 'utf8') };
const descriptions = { en: new Map(tableRows(readme.en)), zh: new Map(tableRows(readme.zh)) };
const order = [...descriptions.en.keys()];
const plugins = [];
for (const dir of await readdir(join(root, 'packages'))) {
  const manifestPath = join(root, 'packages', dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = await readJson(manifestPath);
  if (manifest.private || !manifest.dsh?.bundle) continue;
  const base = join(root, 'packages', dir);
  const en = descriptions.en.get(manifest.name) ?? manifest.description;
  if (!descriptions.en.has(manifest.name)) console.warn(`${manifest.name} is missing from the README plugin table; using package.json description.`);
  plugins.push({
    dir, name: manifest.name,
    title: localized((await heading(join(base, 'README.md'))) ?? manifest.name, await heading(join(base, 'README.zh-CN.md'))),
    description: en && localized(en, descriptions.zh.get(manifest.name)),
    keywords: (manifest.keywords ?? []).filter(keyword => !GENERIC_KEYWORDS.has(keyword)),
  });
}
const rank = name => { const index = order.indexOf(name); return index < 0 ? order.length : index; };
plugins.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

const temp = await mkdtemp(join(tmpdir(), 'dsh-market-'));
const worktree = join(temp, 'worktree');
let attached = false;
try {
  console.log(`Building ${plugins.length} plugins…`);
  const packs = join(temp, 'packs');
  run('pnpm', ['-r', ...plugins.flatMap(plugin => ['--filter', plugin.name]), 'pack', '--pack-destination', packs]);
  const tarballs = await readdir(packs);

  if (succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`])) git(['worktree', 'add', '--quiet', worktree, BRANCH]);
  else if (succeeds(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`])) git(['worktree', 'add', '--quiet', '-b', BRANCH, worktree, `origin/${BRANCH}`]);
  else {
    git(['worktree', 'add', '--quiet', '--detach', worktree]);
    git(['checkout', '--quiet', '--orphan', BRANCH], worktree);
    git(['rm', '-rfq', '.'], worktree);
  }
  attached = true;
  const indexPath = join(worktree, 'index.json');
  const index = existsSync(indexPath) ? await readJson(indexPath) : { format: 1, plugins: [] };
  const listed = new Map(index.plugins.map(plugin => [plugin.name, plugin]));

  const releases = [], unchanged = [], stale = [];
  for (const plugin of plugins) {
    const tarball = tarballs.find(file => file.startsWith(`${plugin.name.replace(/^@/, '').replace('/', '-')}-`) && file.endsWith('.tgz'));
    if (!tarball) throw new Error(`pnpm pack produced no archive for ${plugin.name}.`);
    const extracted = join(temp, 'extract', plugin.dir);
    await mkdir(extracted, { recursive: true });
    run('tar', ['-xzf', join(packs, tarball), '-C', extracted, '--strip-components=1']);
    // Git installs must neither build the package nor resolve this workspace's private packages.
    const manifest = await readJson(join(extracted, 'package.json'));
    delete manifest.scripts; delete manifest.devDependencies;
    await writeFile(join(extracted, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    Object.assign(plugin, { version: manifest.version, engines: manifest.engines?.dsh ? { dsh: manifest.engines.dsh } : {}, icon: await inlineIcon(extracted, manifest) });

    const target = join(worktree, 'packages', plugin.dir);
    if (listed.get(plugin.name)?.versions.some(version => version.version === plugin.version)) {
      if (await digest(extracted) === await digest(target)) unchanged.push(plugin); else stale.push(plugin);
      continue;
    }
    await rm(target, { recursive: true, force: true });
    await cp(extracted, target, { recursive: true });
    releases.push(plugin);
  }

  for (const plugin of stale) console.warn(`${plugin.name} changed since ${plugin.version} was released; bump its version to publish the change.`);
  if (!releases.length) console.log('Nothing new to release: every plugin version is already in the market index.');
  else if (dryRun) {
    console.log(`Would release to ${BRANCH}:`);
    for (const plugin of releases) console.log(`  ${plugin.name} ${plugin.version}`);
  } else {
    git(['add', '--force', '--all', '--', 'packages'], worktree);
    // A rerun after a failed index step finds the packages already committed.
    if (!succeeds(['diff', '--cached', '--quiet'], worktree)) {
      git(['commit', '--quiet', '-m', `release: ${releases.map(plugin => `${plugin.name} ${plugin.version}`).join(', ')}\n\nBuilt from ${repoUrl}/commit/${sourceCommit}`], worktree);
    }
    const commit = git(['rev-parse', 'HEAD'], worktree);
    const publishTimestamp = Math.floor(Date.now() / 1000);

    for (const plugin of plugins) {
      const release = releases.includes(plugin);
      const versions = listed.get(plugin.name)?.versions ?? [];
      listed.set(plugin.name, {
        name: plugin.name,
        title: plugin.title,
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.icon ? { icon: plugin.icon } : {}),
        author: owner,
        homepage: `${repoUrl}/tree/${sourceBranch}/packages/${plugin.dir}`,
        repository: { url: repoUrl, directory: `packages/${plugin.dir}` },
        metadata: { keywords: plugin.keywords },
        versions: release
          ? [{ version: plugin.version, publishTimestamp, source: { type: 'git', url: repoUrl, commit, path: `packages/${plugin.dir}` }, engines: plugin.engines }, ...versions]
          : versions,
      });
    }
    // Plugins no longer in the workspace stay listed, so their installed versions keep resolving.
    const current = new Set(plugins.map(plugin => plugin.name));
    const document = {
      format: 1,
      title: { en: `${owner}'s DSH plugins`, zh: `${owner} 的 DSH 插件` },
      description: { en: `Plugins built from ${repoUrl}`, zh: `构建自 ${repoUrl} 的插件` },
      plugins: [...plugins.map(plugin => listed.get(plugin.name)), ...[...listed.values()].filter(plugin => !current.has(plugin.name))],
    };
    const validated = parseMarketIndex(document, indexUrl);
    await writeFile(indexPath, `${JSON.stringify(document, null, 2)}\n`);
    await writeFile(join(worktree, 'README.md'), `# ${document.title.en}

Generated by \`pnpm release:market\` from [${owner}/${repo}](${repoUrl}). Each directory under \`packages/\` is a built, install-ready plugin, and \`index.json\` is a DSH plugin market index (format 1) listing every released version.

To browse and install these plugins in DSH, open **Plugins**, switch on **Custom plugin markets** under experimental plugins, then add this index source on the **Discover** tab:

    ${indexUrl}

Every listed version pins a commit of this branch. Never rewrite or force-push it.

---

由 [${owner}/${repo}](${repoUrl}) 的 \`pnpm release:market\` 生成。在 DSH 的 **插件** 页面开启实验插件 **Custom plugin markets**，然后在 **Discover** 中添加上面的索引地址。索引中的每个版本都固定到本分支的提交，请勿改写或强制推送本分支。
`);
    git(['add', 'index.json', 'README.md'], worktree);
    git(['commit', '--quiet', '-m', `release: update market index for ${releases.map(plugin => `${plugin.name} ${plugin.version}`).join(', ')}`], worktree);

    console.log(`Released to the ${BRANCH} branch (${git(['rev-parse', '--short', 'HEAD'], worktree)}):`);
    for (const plugin of releases) {
      const version = validated.plugins.find(entry => entry.name === plugin.name).versions.find(entry => entry.version === plugin.version);
      console.log(`  ${plugin.name} ${plugin.version}  ${marketInstallTarget(plugin.name, version).spec}`);
    }
    console.log(`\nPublish with: git push origin ${BRANCH}\nDSH index source: ${indexUrl}`);
  }
  if (unchanged.length) console.log(`\nAlready released: ${unchanged.map(plugin => `${plugin.name} ${plugin.version}`).join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (attached) { try { git(['worktree', 'remove', '--force', worktree]); } catch {} }
  else { try { git(['worktree', 'prune']); } catch {} }
  await rm(temp, { recursive: true, force: true });
}
