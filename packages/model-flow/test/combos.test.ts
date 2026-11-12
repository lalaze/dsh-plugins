import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineName, modelGroups, preferredModel } from '../src/client/model-list.js';
import { combosFrom, placeCombo, renameCombo, sameSetup, startersFor, type Combo } from '../src/combos.js';
import type { CatalogModel, Route } from '../src/routes.js';
import { configFrom } from '../src/store.js';

const remote = (machine: string, label: string, cli: string, model: string, name: string): CatalogModel => ({ provider: `remote-cli-${cli}`, providerName: name, id: `${machine}/${cli}/${encodeURIComponent(model)}`, name: `${label} · ${machine}` });
const claude = (machine: string, model: string, label: string) => remote(machine, label, 'claude', model, 'Claude');
const codex = (machine: string, model: string, label: string) => remote(machine, label, 'codex', model, 'Codex');
const catalog: CatalogModel[] = [
  codex('code', 'gpt-6.1-sol', 'GPT-6.1-Sol'), codex('code', 'gpt-6-luna', 'GPT-6-Luna'),
  claude('mini', 'opus', 'Opus 5.5'), claude('mini', 'sonnet', 'Sonnet 5.5'), claude('mini', 'haiku', 'Haiku 5.5'),
  codex('mini', 'gpt-6.1-sol', 'GPT-6.1-Sol'), codex('mini', 'gpt-6-luna', 'GPT-6-Luna'),
  remote('mini', 'Deepseek-V4.1-Flash', 'codebuddy', 'deepseek-v4.1-flash', 'CodeBuddy Code'), remote('mini', 'Deepseek-V4.1-Flash', 'codebuddy', 'deepseek-v4.1-flash-sg', 'CodeBuddy Code'),
  { provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-v4-pro', name: 'V4 Pro · official' },
];
const route = (model: CatalogModel, effort?: string): Route => ({ provider: model.provider, model: model.id, label: model.name, ...(effort ? { effort } : {}) });

test('the same model on two machines is one row that still offers both', () => {
  const groups = modelGroups(catalog), codexGroup = groups.find(group => group.id === 'remote-cli-codex')!;
  assert.deepEqual(groups.map(group => group.name), ['Codex', 'Claude', 'CodeBuddy Code', 'DeepSeek']);
  assert.deepEqual(codexGroup.rows.map(row => row.label), ['GPT-6.1-Sol', 'GPT-6-Luna']);
  assert.deepEqual(codexGroup.rows[0].models.map(machineName), ['code', 'mini']);
  assert.match(codexGroup.rows[0].keywords, /code.*mini/);
});
test('different models keep their rows, even under one display name', () => {
  const rows = modelGroups(catalog).find(group => group.id === 'remote-cli-codebuddy')!.rows;
  assert.equal(rows.length, 2);
});
test('a name only loses its tail on a remote CLI', () => {
  const row = modelGroups(catalog).find(group => group.id === 'deepseek')!.rows[0];
  assert.equal(row.label, 'V4 Pro · official');
});
test('a row picks the machine asked for first, then its first one', () => {
  const row = modelGroups(catalog).find(group => group.id === 'remote-cli-codex')!.rows[0];
  assert.equal(machineName(preferredModel(row, [undefined, 'mini', 'code'])), 'mini');
  assert.equal(machineName(preferredModel(row, ['elsewhere'])), 'code');
});
test('combos survive a save and bad ones are dropped', () => {
  const opus = route(catalog[2]), sol = route(catalog[0]);
  const config = configFrom({ rounds: 4, combos: [
    { name: ' Mine ', plan: opus, implement: sol, review: opus, rounds: 2 },
    { name: 'Mine', implement: opus, review: opus, rounds: 3 },
    { name: 'no review', implement: sol },
    { implement: sol, review: opus },
    'junk',
    { name: 'x'.repeat(60), implement: sol, review: opus, rounds: 99 },
  ] });
  assert.deepEqual(config.combos!.map(combo => [combo.name.length, combo.rounds]), [[4, 2], [40, 3]]);
  assert.equal(config.combos![0].plan?.label, 'Opus 5.5 · mini');
});
test('no combos key stays absent, and an emptied list stays empty', () => {
  assert.equal('combos' in configFrom({ rounds: 3 }), false);
  assert.deepEqual(configFrom({ rounds: 3, combos: [] }).combos, []);
});
test('a combo takes a new name in place, unless the name is empty, its own or another combo\'s', () => {
  const opus = route(catalog[2]), codex = route(catalog[0]);
  const combos: Combo[] = [{ name: '1', plan: opus, implement: codex, review: opus, rounds: 3 }, { name: 'Quick', implement: codex, review: opus, rounds: 2 }];
  const renamed = renameCombo(combos, '1', '  Codex builds  ');
  assert.deepEqual(renamed?.map(combo => combo.name), ['Codex builds', 'Quick'], 'same place, trimmed');
  assert.deepEqual({ ...renamed![0], name: '1' }, combos[0], 'nothing but the name changes');
  assert.equal(combos[0].name, '1', 'the list passed in is left alone');
  assert.equal(renameCombo(combos, '1', '   '), undefined);
  assert.equal(renameCombo(combos, '1', '1'), undefined);
  assert.equal(renameCombo(combos, '1', ' Quick '), undefined, 'two combos cannot share a name');
  assert.equal(renameCombo(combos, 'gone', 'New'), undefined);
  assert.equal(renameCombo(combos, '1', 'x'.repeat(60))?.[0].name.length, 40, 'as long as a saved name may be');
  // What is saved reads back unchanged.
  assert.deepEqual(combosFrom(renamed!).map(combo => combo.name), ['Codex builds', 'Quick']);
});
test('a setup matches its combo on any machine, but not with another thinking level or round count', () => {
  const onCode = route(catalog[0]), onMini = route(catalog[5]), opus = route(catalog[2]);
  const combo: Combo = { name: 'c', implement: onCode, review: opus, rounds: 3 };
  assert.ok(sameSetup({ implement: onMini, review: opus, rounds: 3 }, combo));
  assert.ok(!sameSetup({ implement: { ...onMini, effort: 'high' }, review: opus, rounds: 3 }, combo));
  assert.ok(!sameSetup({ implement: onMini, review: opus, rounds: 2 }, combo));
  assert.ok(!sameSetup({ plan: opus, implement: onMini, review: opus, rounds: 3 }, combo));
});
test('applying a combo keeps thinking and moves a model off a machine that is gone', () => {
  const gone: CatalogModel = codex('old', 'gpt-6.1-sol', 'GPT-6.1-Sol');
  const combo: Combo = { name: 'c', implement: route(gone, 'high'), review: route(catalog[2]), rounds: 2 };
  const { setup, missing } = placeCombo(combo, catalog);
  assert.deepEqual(missing, []);
  assert.equal(setup.implement?.model, catalog[0].id);
  assert.equal(setup.implement?.label, 'GPT-6.1-Sol · code');
  assert.equal(setup.implement?.effort, 'high');
  assert.equal(setup.rounds, 2);
});
test('a combo names the models it can no longer find, once each and without the machine', () => {
  const lost = route(claude('old', 'fable', 'Fable 5.1'));
  assert.deepEqual(placeCombo({ name: 'c', plan: lost, implement: route(catalog[0]), review: lost, rounds: 3 }, catalog).missing, ['Fable 5.1']);
});
test('first combos only use models this DSH has', () => {
  assert.deepEqual(startersFor(catalog).map(combo => combo.name), ['Codex builds, Claude reviews', 'Claude builds, Codex reviews', 'Claude only', 'Quick, no plan']);
  const onlyClaude = catalog.filter(model => model.provider === 'remote-cli-claude');
  assert.deepEqual(startersFor(onlyClaude).map(combo => combo.name), ['Claude only']);
  assert.deepEqual(startersFor(catalog.filter(model => model.provider === 'deepseek')), []);
  const quick = startersFor(catalog).at(-1)!;
  assert.equal(quick.plan, undefined);
  assert.equal(quick.rounds, 2);
  assert.equal(startersFor(catalog, name => `zh:${name}`)[0].name, 'zh:Codex builds, Claude reviews');
});
test('first combos sit on the machine with the most models when it has them', () => {
  const combo = startersFor(catalog)[0];
  assert.ok(combo.implement.model.startsWith('mini/'), combo.implement.model);
  assert.ok(combo.review.model.startsWith('mini/'), combo.review.model);
  const elsewhere = startersFor([codex('code', 'gpt-6.1-sol', 'GPT-6.1-Sol'), ...catalog.filter(model => model.provider === 'remote-cli-claude')])[0];
  assert.ok(elsewhere.implement.model.startsWith('code/'), elsewhere.implement.model);
});
test('combos can round-trip through their own reader', () => {
  const starters = startersFor(catalog);
  assert.deepEqual(combosFrom(JSON.parse(JSON.stringify(starters))), starters);
});
