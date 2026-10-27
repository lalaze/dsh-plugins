import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranslationPrompt, parseTranslationOutput, resolveTarget, translateSelection } from '../src/translate.js';
import { defaultTranslationSettings, locksDraftsToEnglish, parseTranslationSettings } from '../src/settings.js';
import { MAX_CONTEXT_LENGTH, parseTranslationRequest } from '../src/rpc.js';

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
test('drafts for Claude models lock to English by default, and the keywords are configurable', () => {
  const keywords = defaultTranslationSettings.englishLockModels;
  assert.equal(locksDraftsToEnglish(keywords, { provider: 'remote-cli-claude', model: 'p1/claude/sonnet' }), true);
  assert.equal(locksDraftsToEnglish(keywords, { provider: 'anthropic', model: 'claude-opus-4-1' }), true);
  assert.equal(locksDraftsToEnglish(keywords, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }), true);
  assert.equal(locksDraftsToEnglish(keywords, { provider: 'deepseek-official', model: 'deepseek-flash' }), false);
  assert.equal(locksDraftsToEnglish(keywords, null), false);
  assert.equal(locksDraftsToEnglish(' Codex ,\n gpt-5 ', { provider: 'remote-cli-codex', model: 'p1/codex/o3' }), true);
  assert.equal(locksDraftsToEnglish(' , ', { provider: 'remote-cli-claude', model: 'p1/claude/sonnet' }), false);
  assert.equal(parseTranslationSettings({}).englishLockModels, 'claude, anthropic');
  assert.equal(parseTranslationSettings({ englishLockModels: '' }).englishLockModels, '');
});
test('the paragraph translate button is on by default and only a boolean turns it off', () => {
  assert.equal(parseTranslationSettings({}).paragraphTranslate, true);
  assert.equal(parseTranslationSettings({ paragraphTranslate: false }).paragraphTranslate, false);
  assert.equal(parseTranslationSettings({ paragraphTranslate: 'false' }).paragraphTranslate, true);
});
test('a word with context is translated in the sense of its passage', async () => {
  const prompt = buildTranslationPrompt('committed', 'zh-CN', 'It is committed on local main.');
  assert.match(prompt, /Context: It is committed on local main\./); assert.match(prompt, /Word or phrase: committed/);
  assert.doesNotMatch(buildTranslationPrompt('committed', 'zh-CN'), /Context/);
  let sent = '';
  await translateSelection({ text: 'committed', target: 'auto', context: 'It is committed on local main.', settings }, async (_url, init) => { sent = JSON.parse(String(init?.body)).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: '已提交' } }] }), { status: 200 }); });
  assert.match(sent, /Context: It is committed/);
  assert.equal(parseTranslationRequest({ text: 'word', settings, context: '  around  ' }).context, 'around');
  assert.equal(parseTranslationRequest({ text: 'word', settings, context: 'x'.repeat(5000) }).context!.length, MAX_CONTEXT_LENGTH);
  assert.equal('context' in parseTranslationRequest({ text: 'word', settings, context: 42 }), false);
});
test('translating drafts before sending is on by default and only a boolean turns it off', () => {
  assert.equal(parseTranslationSettings({}).translateOnSend, true);
  assert.equal(parseTranslationSettings({ translateOnSend: false }).translateOnSend, false);
  assert.equal(parseTranslationSettings({ translateOnSend: 'no' }).translateOnSend, true);
});
