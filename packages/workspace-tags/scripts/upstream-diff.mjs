/**
 * Compare src/client/upstream with DeepSeek Harness's ui-workspace at a ref.
 *
 *   node scripts/upstream-diff.mjs              # this fork's changes (against the vendored commit)
 *   node scripts/upstream-diff.mjs dsh-v0.2.2   # what moving to another release involves
 *
 * Needs the GitHub CLI (`gh`). The fetched files go to a new temporary directory.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const VENDORED = '1f81c047fc48fa190a683e469daa699857e9afe8' // dsh-v0.2.1-rc.3
const ref = process.argv[2] ?? VENDORED
const repo = 'repos/deepseek-ai/deepseek-harness'
const prefix = 'packages/client/ui-workspace/src/client/'
const gh = (...args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })

const commit = gh(`${repo}/commits/${ref}`, '--jq', '.sha').trim()
const paths = gh(`${repo}/git/trees/${commit}?recursive=1`, '--jq', `.tree[] | select(.type=="blob") | .path | select(startswith("${prefix}"))`)
  .split('\n').filter(Boolean)
const out = mkdtempSync(join(tmpdir(), 'ui-workspace-'))
for (const path of paths) {
  const file = join(out, path.slice(prefix.length))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, gh('-H', 'Accept: application/vnd.github.raw', `${repo}/contents/${path}?ref=${commit}`))
}
console.error(`ui-workspace at ${ref} (${commit.slice(0, 9)}) -> ${out}`)
const local = resolve(import.meta.dirname, '../src/client/upstream')
const { status } = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--stat', '--patch', out, local], { stdio: 'inherit' })
process.exitCode = status === 1 ? 0 : status ?? 1
