import { bugUrl, descriptionText, imageSources } from './tapd.js';
export const SOURCE_ID = 'tapd';
const hasCjk = (text) => /[㐀-鿿]/u.test(text);
const short = (commit) => commit.slice(0, 9);
export function itemOf(bug, settings) {
    const name = settings.workspaces.find(workspace => workspace.id === bug.workspaceId)?.name || bug.workspaceId, images = imageSources(bug.description).length;
    return {
        source: SOURCE_ID, id: `${bug.workspaceId}/${bug.id}`, ref: bug.id, title: bug.title, body: descriptionText(bug.description), url: bugUrl(bug),
        project: { id: bug.workspaceId, name },
        ...(bug.status ? { status: bug.status } : {}), ...(bug.priority ? { priority: bug.priority } : {}), ...(bug.module ? { module: bug.module } : {}),
        labels: bug.labels, ...(images ? { images } : {}),
    };
}
/** What TAPD is told. A status or a comment the settings switch off is simply not written. */
export function writeBack(event, settings, zh) {
    switch (event.kind) {
        case 'started': return settings.inProgressStatus ? { status: settings.inProgressStatus } : undefined;
        case 'review': return settings.commentOnReview ? { comment: zh
                ? `AI 修复已完成，等待人工验收。\n分支：${event.branch}\n提交：${short(event.commit)}\n${event.checks ? `检查：${event.checks} 项通过` : '未配置检查命令'}`
                : `An AI fix is ready and waits for a person to accept it.\nBranch: ${event.branch}\nCommit: ${short(event.commit)}\n${event.checks ? `Checks passed: ${event.checks}` : 'No check commands are configured'}` } : undefined;
        case 'accepted': {
            if (!settings.doneStatus)
                throw new Error('Set the status an accepted bug gets, in Settings → TAPD, then write back again');
            const comment = event.mergeCommit
                ? zh ? `修复已验收，并合并到 ${event.baseBranch}。\n合并提交：${short(event.mergeCommit)}` : `The fix was accepted and merged into ${event.baseBranch}.\nMerge commit: ${short(event.mergeCommit)}`
                : zh ? `修复已验收，分支 ${event.branch} 已推送。\n提交：${short(event.commit)}` : `The fix was accepted and branch ${event.branch} was pushed.\nCommit: ${short(event.commit)}`;
            return { status: settings.doneStatus, comment };
        }
    }
}
export function tapdSource(client, settings) {
    return {
        id: SOURCE_ID, name: 'TAPD',
        unready() {
            const { auth, owner, workspaces } = settings();
            return auth.token && owner && workspaces.length ? undefined : { key: 'Add the access token, your TAPD name and a TAPD project first.' };
        },
        async fetch(signal) { return (await client.listBugs(signal)).map(bug => itemOf(bug, settings())); },
        async report(item, event) {
            const [workspaceId, id] = item.id.split('/');
            if (!workspaceId || !id)
                throw new Error(`${item.id} is not a TAPD bug`);
            const change = writeBack(event, settings(), hasCjk(item.title));
            if (change)
                await client.update({ workspaceId, id }, change);
        },
        /** The description is read again: its pictures' addresses are not kept, and may have changed since the fetch. */
        async image(item, index, signal) {
            const [workspaceId, id] = item.id.split('/');
            const bug = workspaceId && id ? await client.getBug(workspaceId, id, signal) : undefined, address = bug && imageSources(bug.description)[index];
            const image = address ? await client.image(address, signal) : undefined;
            return image && { data: image.bytes, mediaType: image.mediaType, name: `tapd-${id}-${index + 1}.${image.extension}` };
        },
    };
}
