import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageType, languageOf, lineSeparatorOf } from '../src/kinds.js';

test('code files get their language, plain text files edit without one, and other files are not text by name', () => {
  assert.equal(languageOf('src/app.tsx'), 'tsx');
  assert.equal(languageOf('scripts/build.mjs'), 'javascript');
  assert.equal(languageOf('C:\\work\\main.PY'), 'python');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
  assert.equal(languageOf('docker/Dockerfile.dev'), 'dockerfile');
  assert.equal(languageOf('.env.local'), 'properties');
  assert.equal(languageOf('Makefile'), 'text');
  assert.equal(languageOf('.gitignore'), 'text');
  assert.equal(languageOf('notes.txt'), 'text');
  assert.equal(languageOf('logo.svg'), 'xml');
  for (const path of ['photo.png', 'report.pdf', 'sheet.xlsx', 'archive.tar.gz', 'binary']) assert.equal(languageOf(path), undefined, path);
});

test('images preview by type, including SVG', () => {
  assert.equal(imageType('a/b/Photo.JPG'), 'image/jpeg');
  assert.equal(imageType('icon.svg'), 'image/svg+xml');
  assert.equal(imageType('main.rs'), undefined);
});

test('CRLF is kept only when every line break is one', () => {
  assert.equal(lineSeparatorOf('a\r\nb\r\n'), '\r\n');
  assert.equal(lineSeparatorOf('a\nb\n'), undefined);
  assert.equal(lineSeparatorOf('a\r\nb\n'), undefined);
  assert.equal(lineSeparatorOf('single line'), undefined);
});
