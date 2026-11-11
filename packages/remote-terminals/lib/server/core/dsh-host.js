/** DSH's logger, when the host provides one. */
export const loggerOf = (ctx) => ctx.get('logger');
/** A conversation's preset (composer or /permission), mapped through its sandbox so renamed presets still match; `custom` has no mapping. */
export function permissionOf(ctx, session) {
    const presets = ctx.get('permissionPresets');
    if (!presets || !session)
        return;
    const preset = presets.current(session);
    if (preset === 'auto')
        return 'auto';
    try {
        return presets.resolve(preset).sandbox;
    }
    catch {
        return;
    }
}
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
/**
 * How a remote CLI may act for a conversation. A subagent DSH delegated with the `never` approval policy is
 * unattended: nobody answers its prompts, and its knobs (workspace sandbox, never ask) match no preset, so its
 * sandbox sets the CLI's limits. Other conversations keep {@link permissionOf}, where `custom` keeps the CLI's mode.
 */
export function accessOf(ctx, session) {
    const permission = permissionOf(ctx, session);
    if (!session?.header.parentSession || permission === 'auto')
        return { permission, unattended: false };
    let knobs;
    try {
        knobs = ctx.get('sessionProjections')?.stateOf?.(session, 'permissions');
    }
    catch {
        knobs = undefined;
    }
    const approval = knobs?.approval ?? ctx.get('approval')?.config?.policy ?? 'ask';
    if (approval !== 'never')
        return { permission, unattended: false };
    const sandbox = knobs?.sandbox ?? ctx.get('shell')?.sandboxMode;
    return { permission: permission ?? (SANDBOXES.includes(String(sandbox)) ? sandbox : undefined), unattended: true };
}
