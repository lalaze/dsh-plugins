import { RemoteError, remotePath } from '@dsh-plugins/remote-core/domain.js';
import { initializeCodex } from '@dsh-plugins/remote-core/codex.js';
import { JsonlPeer, quote, type SshTransport } from '@dsh-plugins/remote-core/ssh.js';
import { endHolderScript, SHARED_TUI_FOLDER } from './holder-protocol.js';
import { TUI_CODEX_CHILD, TUI_SUBAGENT_FILE, TUI_USAGE_CAP, type TuiUsageEntry } from './tui-usage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A listed TUI conversation's file, named as its terminal holder is; how many are read, and how large one may be. */
const SHARED_TUI_NAME = /^tui-[0-9a-f]{32}$/, SHARED_TUI_LIMIT = 300;
export const SHARED_TUI_BYTES = 4096;

/** What terminals and TUI conversations run on a machine, over its SSH connection. */
export class TuiRemote {
  constructor(private readonly transport: SshTransport) {}
  /** Ends a terminal's holder and what runs in it, if there is one. */
  async endHolder(holder: string): Promise<void> { await this.transport.exec(endHolderScript(holder), 15_000, { login: false }); }
  /**
   * The TUI conversations listed on this machine for every DSH that uses this account, one record a line; see tui-shared.ts.
   * The most recently changed ones, so that a list grown over years still fits one read.
   */
  sharedTuis(): Promise<string> {
    return this.transport.exec(`dsh_dir="$HOME/${SHARED_TUI_FOLDER}"
[ -d "$dsh_dir" ] || exit 0
ls -t "$dsh_dir" 2>/dev/null | head -n ${SHARED_TUI_LIMIT} | while IFS= read -r dsh_name; do
  case "$dsh_name" in tui-*.json) head -c ${SHARED_TUI_BYTES} "$dsh_dir/$dsh_name" 2>/dev/null; printf '\\n' ;; esac
done
true`, 20_000, { login: false });
  }
  /** Lists a TUI conversation on this machine, or replaces what is listed about it. */
  async putSharedTui(name: string, record: string): Promise<void> {
    if (!SHARED_TUI_NAME.test(name)) throw new RemoteError('Invalid TUI conversation');
    if (Buffer.byteLength(record) > SHARED_TUI_BYTES || /[\0\r\n]/.test(record)) throw new RemoteError('Invalid TUI conversation record');
    await this.transport.exec(`umask 077
dsh_dir="$HOME/${SHARED_TUI_FOLDER}"
mkdir -p "$dsh_dir" || exit 1
dsh_file="$(mktemp "$dsh_dir/.put.XXXXXXXXXX")" || exit 1
printf '%s\\n' ${quote(record)} > "$dsh_file" && mv -f "$dsh_file" "$dsh_dir/${name}.json" || { rm -f "$dsh_file"; exit 1; }`, 20_000, { login: false });
  }
  /** The records that can title a Claude Code session, from its file on this machine if it has saved that session. */
  claudeTitleRecords(claudeSession: string): Promise<string> {
    return this.transport.exec(`dsh_file=$(find "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name ${quote(`${claudeSession}.jsonl`)} 2>/dev/null | head -n 1)
[ -z "$dsh_file" ] || { grep -a -m 5 '"type":"last-prompt"' "$dsh_file"; grep -a '"type":"ai-title"' "$dsh_file" | tail -n 1; grep -a '"type":"custom-title"' "$dsh_file" | tail -n 1; }
true`, 20_000);
  }
  /** The records that can title a Codex thread: its newest line of Codex's name index and its first user messages. */
  codexTitleRecords(thread: string): Promise<string> {
    if (!UUID.test(thread)) throw new RemoteError('Invalid Codex thread');
    return this.transport.exec(`dsh_home="\${CODEX_HOME:-$HOME/.codex}"
grep -a ${quote(thread)} "$dsh_home/session_index.jsonl" 2>/dev/null | tail -n 1
dsh_file=$(find "$dsh_home/sessions" -maxdepth 4 -name ${quote(`rollout-*-${thread}.jsonl`)} 2>/dev/null | head -n 1)
[ -z "$dsh_file" ] || grep -a -m 5 '"type":"UserMessage"' "$dsh_file"
true`, 20_000);
  }
  /**
   * What TUI conversations' CLIs logged since the last read, for their token usage: each file's new whole lines that can
   * hold usage, under a header `@ <entry> <from> <end> <capped> <file>` giving the bytes read. Claude Code's lines lose the
   * message text and its copy of tool inputs, as only the usage is wanted; a long session's log runs to megabytes.
   * See tui-usage.ts.
   */
  tuiUsageLines(entries: readonly TuiUsageEntry[], signal?: AbortSignal, cap = TUI_USAGE_CAP): Promise<Buffer> {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new RemoteError('Invalid read size');
    if (!this.transport.transfer) throw new RemoteError('File transfers are unavailable on this host', 501);
    const offset = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
    const reads = entries.map((entry, index) => {
      if (!UUID.test(entry.id)) return '';
      if (entry.cli === 'codex') {
        const children = Object.entries(entry.read).flatMap(([name, read]) => { const id = TUI_CODEX_CHILD.exec(name)?.[1]; return id ? [[id, offset(read)] as const] : []; });
        const known = children.map(([id, read]) => `${quote(id)}) dsh_start=${read} ;; `).join('');
        const parents = [entry.id, ...children.map(([id]) => id)].map(id => `-e ${quote(`"parent_thread_id":"${id}"`)}`).join(' ');
        const since = entry.since !== undefined && Number.isSafeInteger(entry.since) && entry.since > 0 ? entry.since : undefined;
        // Codex runs a subagent, such as the reviewer of approval requests, in a thread of its own whose first line names
        // its parent. Only threads begun after this one can be its own; once looked for, only files changed since are.
        return `dsh_file=$(find "$dsh_codex" -maxdepth 4 -name ${quote(`rollout-*-${entry.id}.jsonl`)} 2>/dev/null | head -n 1)
if [ -n "$dsh_file" ]; then
  dsh_read ${index} main "$dsh_file" ${offset(entry.read.main)} codex
  dsh_base=\${dsh_file##*/}${since ? `
  dsh_recent=$(find "$dsh_codex" -name 'rollout-*.jsonl' -mmin -${since} 2>/dev/null)` : ''}
  find "$dsh_codex" -name 'rollout-*.jsonl' 2>/dev/null | LC_ALL=C awk -v base="$dsh_base" '{ n = $0; sub(/.*\\//, "", n); if (n > base) print }' |
  while IFS= read -r dsh_child; do
    dsh_id=\${dsh_child%.jsonl}; dsh_id=\${dsh_id#"\${dsh_id%????????????????????????????????????}"}; dsh_start=
    case "$dsh_id" in ${known}*) ;; esac
    if [ -z "$dsh_start" ]; then${since ? `
      case "$dsh_recent" in *"$dsh_child"*) ;; *) continue ;; esac` : ''}
      head -c 4096 "$dsh_child" | LC_ALL=C grep -q -F ${parents} || continue
      dsh_start=0
    fi
    dsh_read ${index} "thread-$dsh_id" "$dsh_child" "$dsh_start" codex
  done
fi`;
      }
      const agents = Object.entries(entry.read).filter(([name]) => TUI_SUBAGENT_FILE.test(name)).map(([name, read]) => `${quote(name)}) dsh_start=${offset(read)} ;; `).join('');
      return `dsh_file=$(find "$dsh_claude" -maxdepth 2 -name ${quote(`${entry.id}.jsonl`)} 2>/dev/null | head -n 1)
if [ -n "$dsh_file" ]; then
  dsh_read ${index} main "$dsh_file" ${offset(entry.read.main)} claude
  for dsh_agent in "\${dsh_file%.jsonl}"/subagents/agent-*.jsonl; do
    [ -f "$dsh_agent" ] || continue
    dsh_name=\${dsh_agent##*/}; dsh_start=0
    case "$dsh_name" in ${agents}*) ;; esac
    dsh_read ${index} "$dsh_name" "$dsh_agent" "$dsh_start" claude
  done
fi`;
    });
    return this.transport.transfer(`dsh_claude="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
dsh_codex="\${CODEX_HOME:-$HOME/.codex}/sessions"
# $1 entry, $2 file name, $3 path, $4 bytes already read, $5 CLI
dsh_read() {
  dsh_end=$(wc -c 2>/dev/null < "$3") || return 0
  dsh_end=$((dsh_end + 0)); dsh_from=$4; dsh_capped=0
  # A shorter file was written anew.
  [ "$dsh_end" -ge "$dsh_from" ] || dsh_from=0
  if [ $((dsh_end - dsh_from)) -gt ${cap} ]; then dsh_end=$((dsh_from + ${cap})); dsh_capped=1; fi
  # Whole lines only: the CLI may be writing the last one.
  if [ "$dsh_end" -gt "$dsh_from" ] && [ "$(tail -c +"$dsh_end" "$3" | head -c 1 | od -An -tx1 | tr -d ' \\n')" != 0a ]; then
    dsh_end=$((dsh_end - $(tail -c +$((dsh_from + 1)) "$3" | head -c $((dsh_end - dsh_from)) | tail -n 1 | wc -c)))
    # A line longer than a whole read is passed over.
    [ "$dsh_capped" = 0 ] || [ "$dsh_end" -gt "$dsh_from" ] || dsh_end=$((dsh_from + $(tail -c +$((dsh_from + 1)) "$3" | head -n 1 | wc -c)))
  fi
  printf '@ %s %s %s %s %s\\n' "$1" "$dsh_from" "$dsh_end" "$dsh_capped" "$2"
  [ "$dsh_end" -gt "$dsh_from" ] || return 0
  if [ "$5" = codex ]; then
    tail -c +$((dsh_from + 1)) "$3" | head -c $((dsh_end - dsh_from)) | LC_ALL=C grep -a -e '"type":"token_count"' -e '"type":"task_started"' -e '"type":"task_complete"' -e '"type":"turn_aborted"' -e '"type":"turn_context"'
  else
    tail -c +$((dsh_from + 1)) "$3" | head -c $((dsh_end - dsh_from)) | LC_ALL=C grep -a -e '"type":"assistant"' -e '"subtype":"turn_duration"' -e '"interruptedMessageId":"' |
      LC_ALL=C sed -E -e 's/"content":\\[.*\\],"(container|stop_reason)"/"content":[],"\\1"/' -e 's/"wireToolInputs":\\{.*\\},"serverClassifierRequest"/"serverClassifierRequest"/'
  fi
  return 0
}
${reads.join('\n')}
true`, { maxBytes: 64 * 1024 * 1024, signal });
  }
  /**
   * Starts a Codex thread for `codex resume` to open, as Codex cannot be told the ID of a session it starts. App server
   * only saves the thread once it has a message or a name, and it needs no message from this connection for a name.
   * @returns the thread's ID.
   */
  async codexThread(cwd: string, name: string, signal: AbortSignal): Promise<string> {
    const path = await this.transport.exec(`printf '%s' "$(command -v codex 2>/dev/null || true)"`, 20_000);
    signal.throwIfAborted();
    if (!path.startsWith('/')) throw new RemoteError('Codex is not installed on this SSH host', 409);
    const peer = new JsonlPeer(this.transport.start(remotePath(cwd), [path, 'app-server']));
    const abort = () => peer.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      peer.onMessage(message => { if (message.method && message.id !== undefined) peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Starting a thread executes nothing' } }); });
      await initializeCodex(peer);
      const result = await peer.request('thread/start', { cwd }) as { thread?: { id?: unknown } } | undefined, id = result?.thread?.id;
      if (typeof id !== 'string' || !UUID.test(id)) throw new RemoteError('Codex did not start a thread', 502);
      await peer.request('thread/name/set', { threadId: id, name });
      return id;
    } finally { signal.removeEventListener('abort', abort); peer.close(); }
  }
}
