import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { createTranslationHandler } from './translate.js';

export const name = 'dsh-translate';
export const inject = ['connection'];

export function apply(ctx: Context): void {
  const translate = createTranslationHandler();
  ctx.connection.fetch.register({ path: '/api/translate', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const body = await request.text();
      if (body.length > 32_000) return Response.json({ error: 'Translation request is too large' }, { status: 413 });
      let input: unknown;
      try { input = JSON.parse(body); } catch { return Response.json({ error: 'Request must be valid JSON' }, { status: 400 }); }
      return Response.json(await translate(input), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed';
      const status = /too many|too large/i.test(message) ? 429 : /must |unsupported|enter |invalid|first|fallback/i.test(message) ? 400 : 502;
      return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
  } });
}

export { createTranslationHandler } from './translate.js';
export { parseUsage, createUsageLedger, translationUsageRoot } from './usage.js';
export { validateTranslationSettings, defaultTranslationSettings } from './settings.js';
