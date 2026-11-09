import { RemoteError } from '../core/domain.js';
/**
 * Fallback for embeddings/tests that did not install the native host adapter.
 * This does not advertise support merely because the CLI sharing service exists.
 */
export function nativeSharingStatus() {
    return {
        enabled: false,
        available: false,
        code: 'native-sharing-host-unavailable',
        message: 'Ordinary conversation sharing needs the native host integration. No ordinary conversations are shared.',
    };
}
/** A stale or hand-written client cannot enable an unsupported feature. Disabling is idempotent. */
export function setNativeSharing(enabled) {
    if (typeof enabled !== 'boolean')
        throw new RemoteError('enabled must be a boolean');
    if (enabled)
        throw new RemoteError(nativeSharingStatus().message, 501);
    return nativeSharingStatus();
}
