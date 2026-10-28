/** Shared, browser-safe workspace contracts. Paths are relative to a verified workspace. */
/** `terminalShell` is the Remote workspace launcher path, as listed in DSH's terminal shell menu. */
export interface WorkspaceTarget { hostId: string; label: string; cwd: string; terminalShell?: string }
export interface WorkspaceEntry { name: string; path: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; modified: string }
export interface WorkspaceFile { path: string; content: string; revision: string; size: number }
export interface WorkspaceManifest { files: Record<string, { hash: string; size: number }>; skipped: string[] }
export type FileOperation =
  | { op: 'list'; path: string }
  | { op: 'read'; path: string }
  | { op: 'stat'; path: string }
  | { op: 'webStart'; path: string; port: number; host: string }
  | { op: 'webStop'; path: string; port: number }
  | { op: 'write'; path: string; content: string; revision: string | null }
  | { op: 'mkdir'; path: string }
  | { op: 'remove'; path: string; revision: string }
  | { op: 'move'; path: string; destination: string; revision: string }
  | { op: 'manifest'; path: string }
  | { op: 'search'; path: string; query: string }
  | { op: 'command'; path: string; command: string; timeoutMs?: number };
export interface SyncChange { path: string; action: 'copy' | 'delete'; source: string | null; destination: string | null }
export interface SyncResult { direction: 'pull' | 'push'; dryRun: boolean; changes: SyncChange[]; conflicts: string[]; skipped: string[]; planId?: string }
export interface TunnelConfig { id: string; hostId: string; direction: 'local' | 'reverse'; listenPort: number; targetPort: number; targetHost: string }
export interface Tunnel extends TunnelConfig { status: 'starting' | 'running' | 'stopped' | 'error'; error?: string }
export interface LegacyMachine { id: string; label: string; connection: string; available: boolean; reason?: string; imported: boolean }
/** Address the browser uses for local tunnel listeners; a managed remote DSH must trust it. */
export const TUNNEL_ACCESS_HOST = '100.96.195.115';
export const FILE_LIMIT = 50 * 1024 * 1024;
export const TEXT_LIMIT = 256 * 1024;
