import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatus, serializeStatus } from '../src/status-file.js';

test('the four sections are read in either language, in any order, with other sections kept apart', () => {
  const parsed = parseStatus(['# zeMoney', '', '## Next steps', 'Ship 1.0.16', '', '## 目标：', '', '支付页上线', '', '## Notes', 'Ask Dana about the invoice', '', '## Blockers', '', '## 进度', '- 审核中', '- 分支 `zowl`', ''].join('\n'));
  assert.deepEqual(parsed.fields, { goal: '支付页上线', progress: '- 审核中\n- 分支 `zowl`', blockers: '', next: 'Ship 1.0.16' });
  assert.equal(parsed.preamble, '# zeMoney');
  assert.deepEqual(parsed.extra, ['## Notes\n\nAsk Dana about the invoice']);
  assert.deepEqual(parsed.headings, { next: 'Next steps', goal: '目标：', blockers: 'Blockers', progress: '进度' });
});

test('a heading inside a code block is code, and a repeated section is a note', () => {
  const parsed = parseStatus(['## Goal', 'First', '```md', '## Next', 'not a section', '```', '## Goal', 'Second'].join('\n'));
  assert.equal(parsed.fields.goal, 'First\n```md\n## Next\nnot a section\n```');
  assert.equal(parsed.fields.next, '');
  assert.deepEqual(parsed.extra, ['## Goal\n\nSecond']);
});

test('saving puts the four first under the headings the file had and leaves the rest as it was', () => {
  const before = '# zeMoney\n\n## Notes\n\nkeep me\n\n## Next steps\n\nold\n';
  const parsed = parseStatus(before);
  const after = serializeStatus({ ...parsed, fields: { goal: 'G', progress: '', blockers: 'waiting for review\n', next: 'new' } }, 'zh', 'zeMoney');
  assert.equal(after, '# zeMoney\n\n## 目标\n\nG\n\n## 进度\n\n## 卡点\n\nwaiting for review\n\n## Next steps\n\nnew\n\n## Notes\n\nkeep me\n');
  // What was written reads back as what was saved.
  assert.deepEqual(parseStatus(after).fields, { goal: 'G', progress: '', blockers: 'waiting for review', next: 'new' });
  assert.equal(serializeStatus(parseStatus(after), 'en', 'x'), after);
});

test('a file that does not exist yet starts with the project as its title, in the language asked for', () => {
  assert.equal(serializeStatus({ ...parseStatus(''), fields: { goal: 'a', progress: 'b', blockers: '', next: 'c' } }, 'en', 'site'), '# site\n\n## Goal\n\na\n\n## Progress\n\nb\n\n## Blockers\n\n## Next\n\nc\n');
});
