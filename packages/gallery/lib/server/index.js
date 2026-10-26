import { createGalleryHandler } from './bing.js';
export const name = 'dsh-gallery';
export const inject = ['connection'];
export function apply(ctx) {
    const fetch = createGalleryHandler();
    for (const path of ['/api/gallery/bing', '/api/gallery/image']) {
        ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch });
    }
}
