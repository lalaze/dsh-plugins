/** Capability result, not a wire protocol advertisement. No native session is enrolled or read. */
export interface NativeSharingStatus {
    enabled: false;
    available: false;
    code: 'native-sharing-host-unavailable';
    message: string;
}
/**
 * Fallback for embeddings/tests that did not install the native host adapter.
 * This does not advertise support merely because the CLI sharing service exists.
 */
export declare function nativeSharingStatus(): NativeSharingStatus;
/** A stale or hand-written client cannot enable an unsupported feature. Disabling is idempotent. */
export declare function setNativeSharing(enabled: unknown): NativeSharingStatus;
