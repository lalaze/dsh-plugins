/** The machine list as the host serves it and the page reads it. No imports: the client bundle includes it. */
export type MachineState = 'online' | 'offline' | 'unreachable';
export interface MachineInfo {
    /** Mount id: stable for one listener address. */
    id: string;
    name: string;
    os: string;
    /** The machine's listener, e.g. `http://100.96.195.115:7390`. */
    url: string;
    source: 'tailnet' | 'static';
    state: MachineState;
    /** Why the last probe failed, in the host's words. */
    reason?: string;
    /** ms since the epoch. */
    lastSeen?: number;
    version?: string;
}
export interface SelfInfo {
    name: string;
    os: string;
    version: string;
    /** This machine's listener, once it listens. */
    url?: string;
    listenError?: string;
    tailnet: {
        running: boolean;
        address?: string;
        error?: string;
    };
}
/** `GET /dsh-link/peers`. */
export interface MachinesAnswer {
    self: SelfInfo;
    machines: MachineInfo[];
}
/** `GET /dsh-link/hello` on a listener. */
export interface Hello {
    dshLink: 1;
    id: string;
    name: string;
    os: string;
    version: string;
}
/**
 * `dshLink`, the service other plugins on this DSH use to reach the other machines (dsh-usage-stats adds up their
 * usage with it). Bump `version` on an incompatible change.
 */
export interface LinkService {
    version: 1;
    /** This machine: its id among machines and the name the others show for it. */
    self(): {
        id: string;
        name: string;
    };
    /** The other machines, as the switcher lists them. */
    machines(): MachineInfo[];
    /**
     * A GET into an online machine's DSH through its listener, signed in there by that machine's own login, as its
     * mount is. `path` is absolute (`/api/…`). Rejects when the machine is unknown or not online, or does not answer.
     */
    get(id: string, path: string, options?: {
        timeoutMs?: number;
        maxBytes?: number;
    }): Promise<{
        status: number;
        text: string;
    }>;
}
