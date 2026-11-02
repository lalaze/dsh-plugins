import { type RemoteBinding } from '../shared/protocol.js';
/** The binding of the workspace at `path`, or undefined when it is not a readable remote workspace. */
export declare function readRemoteBinding(home: string, path: string): Promise<RemoteBinding | undefined>;
