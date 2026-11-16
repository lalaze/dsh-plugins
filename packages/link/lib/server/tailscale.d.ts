export interface TailnetNode {
    /** Stable node id, e.g. `n4u86tzd6121CNTRL`. */
    id: string;
    /** First label of the MagicDNS name, e.g. `lalazemac-mini`; the host name when there is none. */
    name: string;
    /** MagicDNS name without the trailing dot, '' when unknown. */
    dnsName: string;
    os: string;
    ips: string[];
    /** Owner's user id as the CLI prints it. Kept as text: the numbers do not fit a double. */
    userId: string;
    online: boolean;
    tagged: boolean;
    /** ms since the epoch; undefined when never seen or online. */
    lastSeen?: number;
}
export interface TailnetStatus {
    running: boolean;
    self: TailnetNode;
    peers: TailnetNode[];
}
/** @returns the CLI to run: the configured one, else the first candidate that answers `version`. */
export declare function tailscaleCli(configured: string): Promise<string>;
/** JSON with every user and node id quoted first: Tailscale ids are 17-digit integers. */
export declare function parseIds(text: string): unknown;
/** Read `tailscale status --json`. */
export declare function statusOf(text: string): TailnetStatus;
export declare function readStatus(configured: string): Promise<TailnetStatus>;
export interface Whois {
    userId: string;
    node: string;
}
/** Read `tailscale whois --json`: a tagged node's owner is the tag, which has no user profile. */
export declare function whoisOf(text: string): Whois | undefined;
/** @returns the tailnet user behind an address, undefined for a tagged device or a non-tailnet address. */
export declare function whois(configured: string, ip: string): Promise<Whois | undefined>;
