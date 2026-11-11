import { RemoteError } from './domain.js';
import { FILE_LIMIT } from './workspace.js';
/** Requests carry this header, which a page of another origin cannot add without the browser asking first. */
export const requireClient = (request) => { if (request.headers.get('X-DSH-Remote-Agents') !== '1')
    throw new RemoteError('Use the remote agents client to submit requests', 403); };
export const transferFailure = (error) => Response.json({ error: error instanceof Error ? error.message : 'File transfer failed' }, { status: error instanceof RemoteError ? error.status : 502 });
/** The size an upload declares. */
export function transferSize(request) {
    const size = Number(request.headers.get('X-File-Size'));
    if (!request.headers.has('X-File-Size') || !Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT)
        throw new RemoteError('File exceeds the 50 MB transfer limit', 413);
    return size;
}
/** An upload's body as it arrives, held to exactly the size it declared. */
export async function* transferBody(request, size) {
    const reader = request.body?.getReader();
    let bytes = 0;
    if (reader) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                bytes += value.length;
                if (bytes > size)
                    throw new RemoteError('Upload byte count mismatch', 413);
                yield value;
            }
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    if (bytes !== size)
        throw new RemoteError('Upload byte count mismatch');
}
