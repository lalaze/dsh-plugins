import { CLIENT_HEADER, ROUTE, type Aspect, type AssetDetail, type FolderRule, type GeneratedImage, type ImageAnswer, type MoveResult, type ProjectStatus, type SaveResult, type ScanResult, type SourceInput, type SourcesAnswer, type TabMode, type TagResult } from '../domain.js';

export class AssetRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function post<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new AssetRequestError(typeof result.error === 'string' ? result.error : `Assets request failed (${response.status})`, response.status);
  return result as T;
}
export const scanWorkspace = (sessionId: string, refresh: boolean, signal?: AbortSignal) => post<ScanResult>({ action: 'scan', sessionId, refresh }, signal);
export const configureFolders = (sessionId: string, folders: Record<string, FolderRule>, retireDir?: string) => post<ScanResult>({ action: 'configure', sessionId, folders, retireDir });
export const moveAssets = (sessionId: string, action: 'retire' | 'restore', paths: string[]) => post<MoveResult>({ action, sessionId, paths });
export const tagAssets = (sessionId: string, paths: string[], add: string[], remove: string[]) => post<TagResult>({ action: 'tag', sessionId, paths, add, remove });
export const noteAsset = (sessionId: string, path: string, note: string) => post<{ note: string }>({ action: 'note', sessionId, path, note });
export const imageBatch = (sessionId: string, paths: string[], signal?: AbortSignal) => post<{ images: ImageAnswer[] }>({ action: 'images', sessionId, paths }, signal);
export const assetDetail = (sessionId: string, path: string, signal?: AbortSignal) => post<AssetDetail>({ action: 'detail', sessionId, path }, signal);

/** An image's bytes. The header keeps other pages from embedding workspace images, so `<img src>` cannot fetch them. */
export async function imageBytes(sessionId: string, path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { [CLIENT_HEADER]: '1' } });
  if (!response.ok) throw new AssetRequestError(`Image request failed (${response.status})`, response.status);
  return response.arrayBuffer();
}

export const projectStatus = (sessionId: string) => post<ProjectStatus>({ action: 'project', sessionId });
export const setProject = (sessionId: string, game: boolean | null) => post<ProjectStatus>({ action: 'setProject', sessionId, game });
export const tabMode = () => post<{ mode: TabMode }>({ action: 'mode' });
export const setTabMode = (mode: TabMode) => post<{ mode: TabMode }>({ action: 'setMode', mode });

export const listSources = () => post<SourcesAnswer>({ action: 'sources' });
export const saveSource = (source: SourceInput) => post<SourcesAnswer & { id: string }>({ action: 'saveSource', source });
export const deleteSource = (id: string) => post<SourcesAnswer>({ action: 'deleteSource', id });
export const setDefaultSource = (id: string) => post<SourcesAnswer>({ action: 'defaultSource', id });
export interface GenerateOptions { sourceId: string; prompt: string; references: string[]; aspect: Aspect; transparent: boolean }
/** Asks the source for a picture; nothing is written. Aborting stops the call to the image API. */
export const generatePicture = (sessionId: string, options: GenerateOptions, signal?: AbortSignal) => post<GeneratedImage>({ action: 'generate', sessionId, ...options }, signal);
/** Writes a picture, given in base64, to a free path, or in place of an image that is retired first. */
export const savePicture = (sessionId: string, path: string, data: string, replace: boolean) => post<SaveResult>({ action: 'save', sessionId, path, data, replace });
