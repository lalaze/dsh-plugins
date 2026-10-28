import { createHash } from 'node:crypto';
/** Prefix the host uses for browser-session cookies (`dsh-client-connection`). */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-';
function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
/** Same derivation as the host: `dsh-auth-` + base64url(sha256(authority)). */
export function authCookieName(authority) {
    return AUTH_COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}
/**
 * Names the host may use for this request's own session. HTTP listeners key by
 * `host:port`, TLS listeners by origin; both are kept so the live session is
 * never touched regardless of which listener served the request.
 */
export function currentAuthCookieNames(host) {
    const names = new Set();
    if (!host)
        return names;
    for (const scheme of ['http:', 'https:']) {
        try {
            const url = new URL(`${scheme}//${host}`);
            names.add(authCookieName(scheme === 'https:' ? url.origin : url.host));
        }
        catch { /* malformed Host: keep nothing extra */ }
    }
    return names;
}
/** `dsh-auth-*` cookie names in a Cookie header that belong to other (old) ports. */
export function staleAuthCookieNames(cookieHeader, host) {
    if (!cookieHeader)
        return [];
    const keep = currentAuthCookieNames(host);
    // Without a recognisable current cookie we cannot tell which one is live; do nothing.
    const stale = new Set();
    let sawCurrent = false;
    for (const segment of cookieHeader.split(';')) {
        const at = segment.indexOf('=');
        const name = (at === -1 ? segment : segment.slice(0, at)).trim();
        if (!name.startsWith(AUTH_COOKIE_PREFIX))
            continue;
        if (keep.has(name))
            sawCurrent = true;
        else
            stale.add(name);
    }
    return sawCurrent ? [...stale] : [];
}
/** Set-Cookie value that deletes `name` with the attributes the host minted it with. */
export function expireCookie(name, secure) {
    const attributes = `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict`;
    return secure ? `${attributes}; Secure` : attributes;
}
