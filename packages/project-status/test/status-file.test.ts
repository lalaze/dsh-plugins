import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatus, serializeStatus, shown } from '../src/status-file.js';

const goal = (title: string, rest: Record<string, unknown> = {}) => ({ title, done: false, steps: '', progress: '', blockers: '', next: '', ...rest });

test('each goal is read with its own status, in either language, with everything else kept apart', () => {
  const parsed = parseStatus(['# zeMoney', '', '## Notes', 'Ask Dana about the invoice', '', '## Sub-goals', 'in the order they started', '', '### [x] Icons', '#### Progress:', 'shipped', '', '### 支付页', '- [x] 设计', '- [ ] 开发', '',
    '#### 下一步', '跑通回归', '#### Links', 'https://example.com', '#### 卡点', '', '#### 下一步', 'a second one', '', '## 大目标：', '', '记账不用动脑', ''].join('\n'));
  assert.equal(parsed.aim, '记账不用动脑');
  assert.deepEqual(parsed.goals.map(shown), [goal('Icons', { done: true, progress: 'shipped' }), goal('支付页', { steps: '- [x] 设计\n- [ ] 开发', next: '跑通回归' })]);
  // What is not one of the three stays with its goal, and a section named twice is a note the second time.
  assert.deepEqual(parsed.goals[1].rest, ['#### Links\n\nhttps://example.com', '#### 下一步\n\na second one']);
  assert.deepEqual([parsed.preamble, parsed.lead, parsed.extra, parsed.headings], ['# zeMoney', 'in the order they started', ['## Notes\n\nAsk Dana about the invoice'], { goals: 'Sub-goals', aim: '大目标：' }]);
});

test('a heading inside a code block is code', () => {
  const parsed = parseStatus(['## Goal', 'First', '```md', '## Sub-goals', '### not a goal', '```', '## Sub-goals', '### One', '~~~', '#### Next', '~~~', '#### Next', 'go'].join('\n'));
  assert.equal(parsed.aim, 'First\n```md\n## Sub-goals\n### not a goal\n```');
  assert.deepEqual(parsed.goals.map(shown), [goal('One', { steps: '~~~\n#### Next\n~~~', next: 'go' })]);
});

test('writing keeps the file’s own headings and language, leaves out empty texts, and reads back the same', () => {
  const before = '# zeMoney\n\n## Notes\n\nkeep me\n\n## Sub-goals\n\n### Icons\n\n#### Links\n\nkept\n';
  const parsed = parseStatus(before);
  parsed.aim = 'Bookkeeping without thinking\n';
  parsed.goals[0] = { ...parsed.goals[0], done: true, blockers: 'waiting for review\n' };
  parsed.goals.push({ ...goal('  [ ] Payment\npage '), steps: '- [ ] Build', next: 'Run the regression', rest: [] });
  const after = serializeStatus(parsed, 'zh', 'x');
  assert.equal(after, '# zeMoney\n\n## Goal\n\nBookkeeping without thinking\n\n## Sub-goals\n\n### [x] Icons\n\n#### Blockers\n\nwaiting for review\n\n#### Links\n\nkept\n\n### [ ] Payment page\n\n- [ ] Build\n\n#### Next\n\nRun the regression\n\n## Notes\n\nkeep me\n');
  assert.equal(serializeStatus(parseStatus(after), 'zh', 'x'), after);
  assert.deepEqual(parseStatus(after).goals.map(shown), [goal('Icons', { done: true, blockers: 'waiting for review' }), goal('Payment page', { steps: '- [ ] Build', next: 'Run the regression' })]);
});

test('a file that does not exist yet starts with the project as its title, in the language asked for', () => {
  assert.equal(serializeStatus({ ...parseStatus(''), aim: 'a', goals: [{ ...goal('b'), rest: [] }] }, 'en', 'site'), '# site\n\n## Goal\n\na\n\n## Sub-goals\n\n### [ ] b\n');
  assert.equal(serializeStatus(parseStatus(''), 'zh', 'site'), '# site\n\n## 大目标\n\n## 小目标\n');
});

test('the first version’s file, with one status for the whole project, reads as goals', () => {
  // One task at the margin: the project's status was that goal's.
  const one = parseStatus('# shop\n\n## 目标\n\n今年上线\n- [ ] 支付页\n  - [x] 设计\n  - [ ] 开发\n\n## 进度\n\n审核中\n\n## 卡点\n\n等我确认\n\n## 下一步\n\n跑回归\n\n## Notes\n\nn\n');
  assert.deepEqual([one.aim, one.goals.map(shown)], ['今年上线', [goal('支付页', { steps: '- [x] 设计\n- [ ] 开发', progress: '审核中', blockers: '等我确认', next: '跑回归' })]]);
  assert.equal(serializeStatus(one, 'en', 'shop'), '# shop\n\n## 大目标\n\n今年上线\n\n## 小目标\n\n### [ ] 支付页\n\n- [x] 设计\n- [ ] 开发\n\n#### 进度\n\n审核中\n\n#### 卡点\n\n等我确认\n\n#### 下一步\n\n跑回归\n\n## Notes\n\nn\n');
  // Several: nobody can tell which one it was about.
  const several = parseStatus('## Goal\n- [x] Icons\n- [ ] Payment\n## Next\nRun the regression\n');
  assert.deepEqual(several.goals.map(shown), [goal('General', { next: 'Run the regression' }), goal('Icons', { done: true }), goal('Payment')]);
  // A sentence and no list: it is the project's aim, and its status a goal.
  const none = parseStatus('## 目标\n\n支付页上线\n\n## 进度\n\n审核中\n');
  assert.deepEqual([none.aim, none.goals.map(shown), none.headings.aim], ['支付页上线', [goal('整体', { progress: '审核中' })], '目标']);
  // In a file of the new form an old section is somebody's note.
  assert.deepEqual(parseStatus('## 小目标\n\n## 进度\n\nx\n').extra, ['## 进度\n\nx']);
});
