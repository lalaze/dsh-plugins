import type { SshConfigHosts } from './domain.js';
/** List concrete Host aliases; OpenSSH remains responsible for the effective connection options. */
export declare function readSshConfigHosts(options?: {
    home?: string;
    systemConfig?: string;
    environment?: NodeJS.ProcessEnv;
}): Promise<SshConfigHosts>;
