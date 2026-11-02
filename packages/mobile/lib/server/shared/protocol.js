/**
 * What the phone app and this machine say to each other through the relay, and what the desktop settings page asks
 * the host.
 */
export const PROTOCOL = 'dsh-mobile/1';
/** The desktop settings page's route, authenticated by DSH's own connection. */
export const LOCAL_ROUTE = '/api/dsh-mobile';
/** The phone app, served to browsers already signed in to this DSH, for trying it out before it is hosted elsewhere. */
export const APP_ROUTE = '/api/dsh-mobile/app';
/** Its entry page. DSH routes are exact and may not end in `/`, so the app opens at `index.html`. */
export const APP_ENTRY = `${APP_ROUTE}/index.html`;
/** How long a pairing code shown on the desktop stays valid. */
export const OFFER_TTL_MS = 10 * 60_000;
export const DEFAULT_GRANTS = { view: true, control: true };
export const encodeOffer = (offer) => base64url(new TextEncoder().encode(JSON.stringify(offer)));
export function decodeOffer(text) {
    const fragment = text.trim().replace(/^.*#pair=/, '');
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    if (value?.v !== 1 || typeof value.server !== 'string' || typeof value.key !== 'string' || typeof value.relay !== 'string' || typeof value.token !== 'string') {
        throw new Error('This is not a DSH pairing code');
    }
    return value;
}
export function base64url(bytes) {
    let binary = '';
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(text) {
    const standard = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}
/** The six digits both screens show while pairing, from both keys and the token. */
export async function pairingCode(hubKey, phoneKey, token) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PROTOCOL} pair\n${hubKey}\n${phoneKey}\n${token}`)));
    const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
    return String(value % 1_000_000).padStart(6, '0');
}
