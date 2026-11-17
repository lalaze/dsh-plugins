import { RemoteError, remotePath } from './core/domain.js';
import { initializeCodex } from './core/codex.js';
import { JsonlPeer, quote } from './core/ssh.js';
import { endHolderScript } from './holder-protocol.js';
import { TUI_CODEX_CHILD, TUI_SUBAGENT_FILE, TUI_USAGE_CAP } from './tui-usage.js';
import { ANTIGRAVITY_CALLS_PER_READ, ANTIGRAVITY_STEPS_PER_READ } from './tui-usage-antigravity.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What Antigravity's `Authentication required` means over SSH, and on this computer; Remote Agents says the same for its chats. */
export const ANTIGRAVITY_SIGN_IN = 'Antigravity says it is not signed in on this machine. Over SSH it needs Antigravity CLI 1.5.9 or later (`agy update`) and a sign-in of its own (`agy acp --login`). Run them in a terminal on that machine, then try again.';
/** Run here, Antigravity keeps its sign-in in the keychain, apart from the file it signs in to over SSH. */
export const ANTIGRAVITY_SIGN_IN_HERE = 'Antigravity says it is not signed in on this computer. Run `agy acp --login` in a terminal on this computer, not over SSH (a sign-in made over SSH is kept apart), then try again.';
/**
 * `sqlite3` for a machine without the command: the database, `1` to read it as it stands (see `dsh_sql`), then queries;
 * each query's rows, one column each, a line apiece.
 */
export const ANTIGRAVITY_SQL_PYTHON = "import sqlite3, sys; db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro' + ('&immutable=1' if sys.argv[2] else ''), uri=True, timeout=2); [print(row[0]) for query in sys.argv[3:] for row in db.execute(query)]";
/** What terminals and TUI conversations run on a machine, over its SSH connection. */
export class TuiRemote {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    /** Ends a terminal's holder and what runs in it, if there is one. */
    async endHolder(holder) { await this.transport.exec(endHolderScript(holder), 15_000, { login: false }); }
    /** The records that can title a Claude Code session, from its file on this machine if it has saved that session. */
    claudeTitleRecords(claudeSession) {
        return this.transport.exec(`dsh_file=$(find "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name ${quote(`${claudeSession}.jsonl`)} 2>/dev/null | head -n 1)
[ -z "$dsh_file" ] || { grep -a -m 5 '"type":"last-prompt"' "$dsh_file"; grep -a '"type":"ai-title"' "$dsh_file" | tail -n 1; grep -a '"type":"custom-title"' "$dsh_file" | tail -n 1; }
true`, 20_000);
    }
    /** The records that can title a Codex thread: its newest line of Codex's name index and its first user messages. */
    codexTitleRecords(thread) {
        if (!UUID.test(thread))
            throw new RemoteError('Invalid Codex thread');
        return this.transport.exec(`dsh_home="\${CODEX_HOME:-$HOME/.codex}"
grep -a ${quote(thread)} "$dsh_home/session_index.jsonl" 2>/dev/null | tail -n 1
dsh_file=$(find "$dsh_home/sessions" -maxdepth 4 -name ${quote(`rollout-*-${thread}.jsonl`)} 2>/dev/null | head -n 1)
[ -z "$dsh_file" ] || grep -a -m 5 '"type":"UserMessage"' "$dsh_file"
true`, 20_000);
    }
    /**
     * The title and preview Antigravity keeps for a conversation, each on a line of its own; nothing for a conversation it
     * has not summarized yet, which it does after the first prompt. They are in its summary database: through `sqlite3`,
     * which macOS always has, or else Python's, as many Linux machines have Python without the `sqlite3` command.
     */
    antigravityTitleRecords(conversation) {
        if (!UUID.test(conversation))
            throw new RemoteError('Invalid Antigravity conversation');
        const line = (column) => `replace(replace(${column}, char(13), ' '), char(10), ' ')`;
        const query = `select ${line('title')} || char(10) || ${line('preview')} from conversation_summaries where conversation_id = '${conversation}'`;
        const python = "import sqlite3, sys; [print(row[0]) for row in sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True, timeout=2).execute(sys.argv[2])]";
        return this.transport.exec(`dsh_db="$HOME/.gemini/antigravity-cli/conversation_summaries.db"
if [ ! -f "$dsh_db" ]; then :
elif command -v sqlite3 >/dev/null 2>&1; then sqlite3 -readonly -cmd '.timeout 2000' "$dsh_db" ${quote(query)} 2>/dev/null
elif command -v python3 >/dev/null 2>&1; then python3 -c ${quote(python)} "$dsh_db" ${quote(query)} 2>/dev/null
fi
true`, 20_000);
    }
    /**
     * What TUI conversations' CLIs logged since the last read, for their token usage: each file's new whole lines that can
     * hold usage, under a header `@ <entry> <from> <end> <capped> <file>` giving the bytes read. Claude Code's lines lose the
     * message text and its copy of tool inputs, as only the usage is wanted; a long session's log runs to megabytes.
     * Antigravity keeps no log: from its conversation's database come `state`, whether a turn runs, then `calls`, its
     * model calls since the last read (counted, not in bytes), then `steps`, the first bytes of each step since, each row
     * a JSON line. See tui-usage.ts and tui-usage-antigravity.ts.
     */
    tuiUsageLines(entries, signal, cap = TUI_USAGE_CAP) {
        if (!Number.isSafeInteger(cap) || cap < 1)
            throw new RemoteError('Invalid read size');
        if (!this.transport.transfer)
            throw new RemoteError('File transfers are unavailable on this host', 501);
        const offset = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
        const calls = Math.max(1, Math.min(ANTIGRAVITY_CALLS_PER_READ, Math.floor(cap / 4096)));
        const reads = entries.map((entry, index) => {
            if (!UUID.test(entry.id))
                return '';
            if (entry.cli === 'antigravity') {
                const from = offset(entry.read.calls), step = offset(entry.read.steps);
                // Rows as JSON lines built by SQLite itself; blobs as hex. A call's row is about 1.3 KB.
                const head = `select '@ ${index} ${from} ' || coalesce((select max(idx) + 1 from (select idx from gen_metadata where idx >= ${from} order by idx limit ${calls})), ${from}) || ' ' || (select count(*) > ${calls} from (select 1 from gen_metadata where idx >= ${from} limit ${calls + 1})) || ' calls'`;
                const rows = `select '{"g":' || idx || ',"d":"' || hex(data) || '"}' from gen_metadata where idx >= ${from} order by idx limit ${calls}`;
                const steps = `select '{"s":' || idx || ',"t":' || step_type || ',"m":"' || hex(substr(metadata, 1, 32)) || '"}' from steps where idx >= ${step} order by idx limit ${ANTIGRAVITY_STEPS_PER_READ}`;
                const state = `select '{"status":"' || replace(status, '"', '') || '","busy":' || (case when not_fully_idle then 1 else 0 end) || '}' from conversation_summaries where conversation_id = '${entry.id}'`;
                // The state comes first: once it says a turn has ended, every call of that turn is already written.
                return `dsh_db="$dsh_agy/conversations/${entry.id}.db"
if [ -f "$dsh_db" ]; then
  printf '@ %s 0 0 0 state\\n' ${index}
  dsh_sql "$dsh_agy/conversation_summaries.db" ${quote(state)}
  dsh_sql "$dsh_db" ${quote(head)} ${quote(rows)}
  printf '@ %s %s %s 0 steps\\n' ${index} ${step} ${step}
  dsh_sql "$dsh_db" ${quote(steps)}
fi`;
            }
            if (entry.cli === 'codex') {
                const children = Object.entries(entry.read).flatMap(([name, read]) => { const id = TUI_CODEX_CHILD.exec(name)?.[1]; return id ? [[id, offset(read)]] : []; });
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
dsh_agy="$HOME/.gemini/antigravity-cli"
# $1 database, then queries, each row's one column on a line: through \`sqlite3\`, which macOS always has, or else
# Python's, as many Linux machines have Python without the \`sqlite3\` command. Read only, ignoring ~/.sqliterc.
# Antigravity keeps its databases in WAL mode and closes them between turns, and a read-only connection cannot open
# such a database without its -shm file: with none, nothing has it open, and it is read as it stands.
dsh_sql() {
  dsh_db_=$1; shift; dsh_still=
  [ -e "$dsh_db_-shm" ] || case "$dsh_db_" in *[?#%]*) ;; *) dsh_still=1 ;; esac
  if command -v sqlite3 >/dev/null 2>&1; then
    dsh_open=$dsh_db_; [ -z "$dsh_still" ] || dsh_open="file:$dsh_db_?immutable=1"
    for dsh_query in "$@"; do sqlite3 -readonly -batch -list -noheader -init /dev/null -cmd '.timeout 2000' "$dsh_open" "$dsh_query" 2>/dev/null; done
  elif command -v python3 >/dev/null 2>&1; then python3 -c ${quote(ANTIGRAVITY_SQL_PYTHON)} "$dsh_db_" "$dsh_still" "$@" 2>/dev/null
  fi
  return 0
}
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
    async codexThread(cwd, name, signal) {
        const path = await this.transport.exec(`printf '%s' "$(command -v codex 2>/dev/null || true)"`, 20_000);
        signal.throwIfAborted();
        if (!path.startsWith('/'))
            throw new RemoteError('Codex is not installed on this SSH host', 409);
        const peer = new JsonlPeer(this.transport.start(remotePath(cwd), [path, 'app-server']));
        const abort = () => peer.close();
        signal.addEventListener('abort', abort, { once: true });
        try {
            peer.onMessage(message => { if (message.method && message.id !== undefined)
                peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Starting a thread executes nothing' } }); });
            await initializeCodex(peer);
            const result = await peer.request('thread/start', { cwd }), id = result?.thread?.id;
            if (typeof id !== 'string' || !UUID.test(id))
                throw new RemoteError('Codex did not start a thread', 502);
            await peer.request('thread/name/set', { threadId: id, name });
            return id;
        }
        finally {
            signal.removeEventListener('abort', abort);
            peer.close();
        }
    }
    /**
     * Starts an Antigravity conversation for `agy --conversation` to open, as Antigravity cannot be told the ID of one it
     * starts: it ignores an ID it does not know and starts another. Its ACP server makes one that the interactive CLI opens,
     * and closing it there first is what lets that CLI run turns in it.
     * @returns the conversation's ID.
     */
    /** @param here - the conversation's folder is on this computer, whose Antigravity sign-in is not the SSH one. */
    async antigravityConversation(cwd, signal, here = false) {
        const path = await this.transport.exec(`printf '%s' "$(command -v agy 2>/dev/null || true)"`, 20_000);
        signal.throwIfAborted();
        if (!path.startsWith('/'))
            throw new RemoteError('Antigravity is not installed on this SSH host', 409);
        const peer = new JsonlPeer(this.transport.start(remotePath(cwd), [path, 'acp']));
        const abort = () => peer.close();
        signal.addEventListener('abort', abort, { once: true });
        try {
            peer.onMessage(message => { if (message.method && message.id !== undefined)
                peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Starting a conversation executes nothing' } }); });
            await peer.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'dsh-remote-terminals', version: '1' } });
            let result;
            try {
                result = await peer.request('session/new', { cwd, mcpServers: [] }, 60_000);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/^authentication required\.?$/i.test(message.trim()))
                    throw new RemoteError(here ? ANTIGRAVITY_SIGN_IN_HERE : ANTIGRAVITY_SIGN_IN, 409);
                throw error;
            }
            const id = result?.sessionId;
            if (typeof id !== 'string' || !UUID.test(id))
                throw new RemoteError('Antigravity did not start a conversation', 502);
            await peer.request('session/close', { sessionId: id });
            return id;
        }
        finally {
            signal.removeEventListener('abort', abort);
            peer.close();
        }
    }
}
