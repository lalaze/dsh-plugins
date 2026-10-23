import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranslationPrompt, parseTranslationOutput, resolveTarget, translateSelection } from '../src/translate.js';
import { defaultTranslationSettings } from '../src/settings.js';

const settings = { ...defaultTranslationSettings, apiUrl: 'http://127.0.0.1:9999/v1/chat/completions', model: 'qwen-local' };
test('auto target chooses English for Chinese and Chinese otherwise', () => {
  assert.equal(resolveTarget('你好，世界', 'auto'), 'en');
  assert.equal(resolveTarget('hello world', 'auto'), 'zh-CN');
  assert.match(buildTranslationPrompt('hello', 'zh-CN'), /Simplified Chinese/);
});
test('parses JSON wrappers, fenced output, and plain output', () => {
  assert.equal(parseTranslationOutput('{"translation":"你好","detectedLanguage":"en"}').translation, '你好');
  assert.equal(parseTranslationOutput('```json\n{"translation":"你好"}\n```').translation, '你好');
  assert.equal(parseTranslationOutput('你好').translation, '你好');
});
test('calls OpenAI-compatible API with non-thinking options for local Qwen', async () => {
  let request: RequestInit | undefined;
  const result = await translateSelection({ text: 'hello', target: 'zh-CN', settings }, async (_url, init) => { request = init; return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200 }); });
  assert.equal(result.translation, '你好');
  const body = JSON.parse(String(request?.body));
  assert.equal(body.enable_thinking, false);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
});
test('uses fallback after primary error', async () => {
  let calls = 0; const fallback = { ...settings, apiUrl: 'http://fallback.invalid', fallbackApiUrl: 'https://example.invalid', fallbackModel: 'backup' };
  const result = await translateSelection({ text: 'hello', target: 'zh-CN', settings: fallback }, async () => { calls++; return calls === 1 ? new Response('bad', { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 }); });
  assert.equal(result.model, 'backup'); assert.equal(calls, 2);
});
