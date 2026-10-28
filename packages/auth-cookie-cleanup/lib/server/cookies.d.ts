/** Prefix the host uses for browser-session cookies (`dsh-client-connection`). */
export declare const AUTH_COOKIE_PREFIX = "dsh-auth-";
/** Same derivation as the host: `dsh-auth-` + base64url(sha256(authority)). */
export declare function authCookieName(authority: string): string;
/**
 * Names the host may use for this request's own session. HTTP listeners key by
 * `host:port`, TLS listeners by origin; both are kept so the live session is
 * never touched regardless of which listener served the request.
 */
export declare function currentAuthCookieNames(host: string | undefined): Set<string>;
/** `dsh-auth-*` cookie names in a Cookie header that belong to other (old) ports. */
export declare function staleAuthCookieNames(cookieHeader: string | undefined, host: string | undefined): string[];
/** Set-Cookie value that deletes `name` with the attributes the host minted it with. */
export declare function expireCookie(name: string, secure: boolean): string;
