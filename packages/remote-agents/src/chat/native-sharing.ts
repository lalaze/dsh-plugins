import { RemoteError } from '@dsh-plugins/remote-core/domain.js';

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
export function nativeSharingStatus(): NativeSharingStatus {
  return {
    enabled: false,
    available: false,
    code: 'native-sharing-host-unavailable',
    message: 'Ordinary conversation sharing needs the native host integration. No ordinary conversations are shared.',
  };
}

/** A stale or hand-written client cannot enable an unsupported feature. Disabling is idempotent. */
export function setNativeSharing(enabled: unknown): NativeSharingStatus {
  if (typeof enabled !== 'boolean') throw new RemoteError('enabled must be a boolean');
  if (enabled) throw new RemoteError(nativeSharingStatus().message, 501);
  return nativeSharingStatus();
}
