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
