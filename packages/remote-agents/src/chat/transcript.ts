import type { TimelineEntry } from '../core/domain.js';

/** Main-chat prompts carry earlier DSH messages ahead of the request; the transcript shows only what the user typed. */
const CONTEXT = /^Conversation context \(already occurred; do not repeat completed actions\):\n[\s\S]*?\n\nCurrent user request:\n/;
const USER_LIMIT = 4000, REPLY_LIMIT = 8000, TOTAL_LIMIT = 60_000;

/** Where turns this conversation did not send came from: another DSH by name, Open sessions in this one, or not recorded. */
export type TurnSource = { name: string } | { self: true } | undefined;

const LABELS = {
  en: {
    title: (cli: string, creator: string | undefined, turns: number) => `**History of this ${cli} session**${creator ? ` (started on ${creator})` : ''}, ${turns} ${turns === 1 ? 'turn' : 'turns'}. Messages sent here continue the same session.`,
    elsewhere: (cli: string, from: TurnSource, turns: number) => `**${turns} ${turns === 1 ? 'turn' : 'turns'} ${from && 'name' in from ? `on ${from.name}` : from ? 'in Open sessions' : 'sent elsewhere'}**, in the same ${cli} session.`,
    own: (cli: string, turns: number) => `**${cli} continued on its own: ${turns} ${turns === 1 ? 'turn' : 'turns'}** without a new message, as after a background task it ran finished.`,
    omitted: (turns: number) => `_${turns} earlier ${turns === 1 ? 'turn is' : 'turns are'} not shown. The full record is in Settings → Remote agents → Open sessions._`,
    you: 'You', continued: 'Continued on its own', tools: 'Tools', interrupted: 'Interrupted', attachments: (n: number) => `${n} ${n === 1 ? 'attachment' : 'attachments'}`,
    switched: (from: string, to: string) => `Switched from ${from} to ${to}`,
    switchNote: (from: string, to: string, category: string) => `**Model switched.** ${from}'s safeguards stopped this request${category}, so ${to} retried it. Later turns in this session stay on ${to}, and the model picker does not change to show it. To use another model, pick a different one; it applies to your next message.`,
    running: (tool: string, more: number) => `Running ${tool}${more ? ` (${more} more running)` : ''}`,
  },
  zh: {
    title: (cli: string, creator: string | undefined, turns: number) => `**这段 ${cli} 会话的历史记录**${creator ? `（在 ${creator} 上开始）` : ''}，共 ${turns} 轮。在这里发消息会接着同一个会话继续。`,
    elsewhere: (cli: string, from: TurnSource, turns: number) => `**${from && 'name' in from ? `在 ${from.name} 上` : from ? '在「打开会话」里' : '在别处'}进行的 ${turns} 轮**，同一个 ${cli} 会话。`,
    own: (cli: string, turns: number) => `**${cli} 自行继续了 ${turns} 轮**，没有新消息，例如它跑的后台任务完成后接着做。`,
    omitted: (turns: number) => `_前面还有 ${turns} 轮没有显示，完整记录在「设置 → 远程智能体 → 打开会话」里。_`,
    you: '你', continued: '自行继续', tools: '工具', interrupted: '已中断', attachments: (n: number) => `${n} 个附件`,
    switched: (from: string, to: string) => `从 ${from} 切换到 ${to}`,
    switchNote: (from: string, to: string, category: string) => `**模型已切换。** ${from} 的安全机制拦截了这条消息${category}，这一轮改由 ${to} 重试。这段会话后面的轮次也继续用 ${to}，模型选择器不会跟着变。要换模型，选另一个模型，发下一条消息时生效。`,
    running: (tool: string, more: number) => `正在运行 ${tool}${more ? `（另有 ${more} 个工具在运行）` : ''}`,
  },
};

/** What the chat says at a `model_switch` item, in the language of what the user wrote. */
export function modelSwitchNote(item: TimelineEntry['item'], userText: string): string {
  const labels = /[㐀-鿿]/.test(userText) ? LABELS.zh : LABELS.en;
  return labels.switchNote(String(item.from), String(item.to), item.category ? ` (${String(item.category)})` : '');
}

/** A sentence wraps with the line around it. Code does not: DSH moves code that does not fit to a line of its own, so it stays short. */
const TOOL_SENTENCE_LIMIT = 100, TOOL_CODE_LIMIT = 60;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
function clip(text: string, limit: number, cut = false): string {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join('').trimEnd()}…` : cut ? `${text}…` : text;
}
/** A long path keeps its end, which names the file, starting at a folder. */
function clipPath(path: string): string {
  const characters = [...path];
  if (characters.length <= TOOL_CODE_LIMIT) return path;
  const end = characters.slice(1 - TOOL_CODE_LIMIT).join('');
  return `…${end.slice(Math.max(end.indexOf('/'), 0))}`;
}
/** Code keeps markdown in it as written, and only a backtick could end it early. It needs no separator, which DSH could leave alone on the line above. */
const asCode = (text: string) => ` \`${text.replace(/`/g, "'")}\``;
const asSentence = (text: string) => ` · ${clip(oneLine(text), TOOL_SENTENCE_LIMIT).replace(/[\\`*_~[\]<>|$&]/g, '\\$&')}`;
/**
 * What a tool works on. The CLI's own sentence comes first: 90% of the commands in real sessions run past 100 characters and
 * a third are several lines, while 96% come with a sentence of about 50 characters.
 */
function toolTarget(input: Record<string, unknown>): string {
  const field = (...keys: string[]) => keys.map(key => input[key]).find((v): v is string => typeof v === 'string' && !!v.trim())?.trim() ?? '';
  const description = field('description');
  if (description) return asSentence(description);
  const [line, ...rest] = field('command').split('\n');
  if (line) return asCode(clip(oneLine(line), TOOL_CODE_LIMIT, rest.length > 0));
  const path = field('file_path', 'path');
  if (path) return asCode(clipPath(oneLine(path)));
  const other = field('pattern', 'query', 'url');
  if (other) return asCode(clip(oneLine(other), TOOL_CODE_LIMIT));
  const prompt = field('prompt');
  return prompt ? asSentence(prompt) : '';
}

/** The line a reply ends with while tools run: the one started last and what it works on, in the language of what the user wrote. */
export function toolStatus(running: readonly TimelineEntry['item'][], userText: string): string {
  const call = running.at(-1);
  if (!call) return '';
  const input = typeof call.detail === 'object' && call.detail !== null ? call.detail as Record<string, unknown> : {};
  const labels = /[㐀-鿿]/.test(userText) ? LABELS.zh : LABELS.en;
  return `> ${labels.running(`${String(call.name ?? 'Tool')}${toolTarget(input)}`, running.length - 1)}`;
}

/** `unprompted`: the CLI started the turn itself; `user` then holds the task notices it got, if any. */
interface Turn { user?: string; at?: string; unprompted?: true; attachments: number; replies: string[]; tools: Map<string, number>; errors: string[]; switches: [string, string][]; interrupted: boolean }

/** A cut keeps code fences balanced, so the rest of the transcript does not render as code. */
const fences = (text: string) => (text.match(/^\s*```/gm) ?? []).length;
function head(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}${fences(kept) % 2 ? '\n```' : ''}\n…`;
}
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const kept = text.slice(-limit);
  return `…\n${fences(kept) % 2 ? '```\n' : ''}${kept}`;
}
const closed = (text: string) => fences(text) % 2 ? `${text}\n\`\`\`` : text;
function stamp(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return ` · ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * One markdown block of a remote CLI session's saved history: what the user asked, what the CLI answered, and which
 * tools it used. Latest turns win when the history is long; the full record stays in the sessions panel.
 * With `elsewhere` the entries are turns sent outside this conversation, headed by where they came from.
 */
export function transcript(entries: readonly TimelineEntry[], options: { cli: string; creator?: string; elsewhere?: { from: TurnSource } }): { text: string; lastMessageId?: string } {
  const turns: Turn[] = [];
  let turn: Turn | undefined, replying = false, lastMessageId: string | undefined;
  const current = () => turn ??= (turns.push({ attachments: 0, replies: [], tools: new Map(), errors: [], switches: [], interrupted: false }), turns.at(-1)!);
  const seenTools = new Set<string>();
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === 'user_message') {
      turn = undefined; replying = false;
      const next = current();
      next.user = String(item.text ?? '').replace(CONTEXT, '').trim(); next.at = entry.timestamp;
      next.attachments = Array.isArray(item.attachments) ? item.attachments.length : 0;
      if (item.unprompted === true) next.unprompted = true;
      if (typeof item.clientMessageId === 'string') lastMessageId = item.clientMessageId;
      continue;
    }
    const target = current();
    if (item.type === 'assistant_message') {
      const text = String(item.text ?? '');
      if (!text) continue;
      if (replying) target.replies[target.replies.length - 1] += text; else target.replies.push(text);
      replying = true; continue;
    }
    if (item.type === 'reasoning' || item.type === 'delivery') continue;
    replying = false;
    if (item.type === 'tool_call') {
      const key = String(item.callId ?? entry.seqStart);
      if (seenTools.has(key)) continue;
      seenTools.add(key);
      const name = typeof item.name === 'string' && item.name ? item.name : 'Tool';
      target.tools.set(name, (target.tools.get(name) ?? 0) + 1);
    } else if (item.type === 'error') target.errors.push(String(item.message ?? ''));
    else if (item.type === 'model_switch') target.switches.push([String(item.from), String(item.to)]);
    else if (item.type === 'interrupted' || item.type === 'turn_end' && item.status === 'canceled') target.interrupted = true;
  }
  // The user's language decides; a turn the CLI started itself has no user text, so its replies stand in.
  const labels = /[㐀-鿿]/.test(turns.map(t => t.unprompted ? t.replies.join('') : t.user ?? '').join('')) ? LABELS.zh : LABELS.en;
  const blocks = turns.map(t => {
    const parts: string[] = [];
    if (t.unprompted) parts.push(`**${labels.continued}**${stamp(t.at)}${t.user ? `\n\n${closed(head(t.user, USER_LIMIT))}` : ''}`);
    else if (t.user !== undefined) {
      const extra = t.attachments ? ` (${labels.attachments(t.attachments)})` : '';
      parts.push(`**${labels.you}**${stamp(t.at)}${extra}\n\n${closed(head(t.user || '…', USER_LIMIT))}`);
    }
    const reply = t.replies.map(r => r.trim()).filter(Boolean).join('\n\n');
    const notes = [
      ...(t.tools.size ? [`${labels.tools}: ${[...t.tools].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(' · ')}`] : []),
      ...t.switches.map(([from, to]) => labels.switched(from, to)),
      ...t.errors.filter(Boolean).map(error => head(error.replace(/\s+/g, ' '), 300)),
      ...(t.interrupted ? [labels.interrupted] : []),
    ];
    if (reply || notes.length) parts.push(`**${options.cli}**${reply ? `\n\n${closed(tail(reply, REPLY_LIMIT))}` : ''}${notes.length ? `\n\n_${notes.join(' · ').replace(/_/g, '\\_')}_` : ''}`);
    return parts.join('\n\n');
  });
  // Newest first until the budget is spent; the latest turn is always shown.
  const shown: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (shown.length && size + blocks[i].length > TOTAL_LIMIT) break;
    shown.unshift(blocks[i]); size += blocks[i].length;
  }
  const omitted = blocks.length - shown.length;
  const title = !options.elsewhere ? labels.title(options.cli, options.creator, turns.length)
    : turns.length && turns.every(t => t.unprompted) ? labels.own(options.cli, turns.length) : labels.elsewhere(options.cli, options.elsewhere.from, turns.length);
  const text = [title, ...(omitted ? [labels.omitted(omitted)] : []), ...shown].join('\n\n---\n\n');
  return { text, ...(lastMessageId ? { lastMessageId } : {}) };
}
