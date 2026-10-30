import Schema from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { panelHandler, PanelHost, setVersion } from './gp-host.js';
import { DEFAULT_CONFIG } from './gp/host/core.js';
import { Credentials } from './credentials.js';
import { editorHandler } from './editor-route.js';
import { GitView } from './git.js';
import { createHandler } from './http.js';
import { gitExecutable, isRemoteAnchor, LocalRunner } from './runner.js';
export const name = 'dsh-git-view';
export const inject = ['connection', 'subprocess'];
/** A conversation's working directory, from the live session or, before it is opened, from saved sessions. */
async function sessionCwd(ctx, sessionId) {
    const sessions = ctx.get('sessions');
    const live = sessions?.get?.(sessionId);
    if (live)
        return live.header.cwd;
    const persistence = ctx.get('sessionPersistence');
    const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
    // A session activated meanwhile is the authority.
    return sessions?.get?.(sessionId)?.header.cwd ?? stored?.cwd;
}
/**
 * The Git panel's settings, as dsh-git-panel offers them on the plugin's detail page: volatile fields apply at once; the
 * limits stay in the profile.
 */
export const Config = Schema.object({
    showInputPill: Schema.boolean().default(true).volatile().description('显示输入框的 Git 分支标记'),
    placement: Schema.union([
        Schema.const('all').description('标签页和侧边栏都显示'),
        Schema.const('tab').description('只在对话区的标签页显示'),
        Schema.const('sidebar').description('只在右侧边栏显示'),
    ]).default('all').volatile().description('Git 面板入口位置'),
    defaultDiffView: Schema.union([
        Schema.const('unified').description('统一视图（单栏行内对比）'),
        Schema.const('split').description('并排视图（左右分栏对比）'),
    ]).default('unified').volatile().description('差异对比默认视图'),
    graphStyle: Schema.union([
        Schema.const('parallel').description('平行线（VSCode 风格，分支各占一列）'),
        Schema.const('compact').description('紧凑（git log 风格，共享祖先合并为一列）'),
    ]).default('parallel').volatile().description('提交历史图线条样式'),
    fontDelta: Schema.union([
        Schema.const(-1).description('较小'),
        Schema.const(0).description('默认'),
        Schema.const(1).description('较大'),
    ]).default(0).volatile().description('面板字号'),
    detectCheckouts: Schema.boolean().default(true).volatile().description('探测 worktree 和子仓库（关闭后存储库列表只保留工作区主仓库；当前目录不是仓库时列表为空）'),
    filesFollowRepo: Schema.boolean().default(false).volatile().description('文件浏览跟随 Git 仓库切换（关闭时文件浏览停在项目根目录）'),
    suggestEnabled: Schema.boolean().default(true).volatile().description('提交框显示 AI 生成按钮'),
    suggestLanguage: Schema.union([
        Schema.const('auto').description('自动跟随仓库历史提交的语言'),
        Schema.const('zh').description('中文'),
        Schema.const('en').description('English'),
    ]).default(DEFAULT_CONFIG.suggestLanguage).volatile().description('AI 生成提交信息的语言'),
    // Defaults come from DEFAULT_CONFIG (which itself reads SUGGEST_LIMITS) —
    // a literal here could silently drift from what normalizeConfig enforces.
    suggestMaxBytes: Schema.number().default(DEFAULT_CONFIG.suggestMaxBytes).volatile().description('AI 生成输入预算（diff 字节上限，16–512 KiB）'),
    suggestMaxOutputTokens: Schema.number().default(DEFAULT_CONFIG.suggestMaxOutputTokens).volatile().description('AI 生成输出上限（tokens，256–16384）'),
    suggestTimeoutMs: Schema.number().default(DEFAULT_CONFIG.suggestTimeoutMs).volatile().description('AI 生成超时（毫秒，5–120 秒）'),
    // Fixed model route: both halves of the pair must be non-empty to take
    // effect (normalizeConfig); effort is omitted from the request when blank.
    // No .default(): without one the field stays optional in the object schema.
    suggestProvider: Schema.string().volatile().description('AI 生成固定模型的 provider（留空 = 跟随会话默认）'),
    suggestModel: Schema.string().volatile().description('AI 生成固定模型的 model id（须与 provider 成对）'),
    suggestReasoningEffort: Schema.string().volatile().description('AI 生成固定模型的推理强度（留空 = 不设置，用模型默认）'),
});
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export function apply(ctx, config = {}) {
    const subprocess = ctx.get('subprocess'), git = gitExecutable(subprocess), credentials = new Credentials(join(stateDir(), 'git-credentials'));
    const view = new GitView({
        cwdOf: id => sessionCwd(ctx, id),
        isRemoteCwd: isRemoteAnchor,
        local: cwd => new LocalRunner(subprocess, git, cwd, () => credentials.config()),
        // Remote Agents runs Git in its remote workspaces; read it per request, as it may load, reload or leave at any time.
        remote: () => ctx.get('remoteAgentsWorkspaces'),
        credentials,
    });
    const log = (message) => ctx.get('logger')?.warn?.(message);
    ctx.connection.fetch.register({ path: '/api/git-view', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(view, log) });
    try {
        setVersion(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    }
    catch { /* the panel shows 0.0.0 */ }
    const panel = new PanelHost({
        cwdOf: id => sessionCwd(ctx, id), isRemoteCwd: isRemoteAnchor, subprocess: subprocess, git, gitConfig: () => credentials.config(),
        remote: () => ctx.get('remoteAgentsWorkspaces'), get: name => ctx.get(name), config,
    });
    ctx.connection.fetch.register({ path: '/api/git-view/gp', methods: ['POST'], requestBody: 'buffered', fetch: panelHandler(panel, log) });
    // The client's EDITOR_SRC; the build writes the bundle next to lib/server.
    ctx.connection.fetch.register({ path: '/api/git-view/editor.js', methods: ['GET'], requestBody: 'buffered', fetch: editorHandler(new URL('../editor.js', import.meta.url)) });
}
