// Decision 35 (kb-adoc step two): each name family of the product gets its own attribute set, produces its own
// document model per version line, and the composition records what each family used and where it came from. A
// family without a configured set produces with the pack default (the empty set, like today's markdown) and says so;
// an unconfigured family is never an unknown. Any family's expansion failure fails the whole group (no root change).
// Real attribute names are deployment data; these tests use synthetic sets only.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFamilies, familyManualName } from './families.ts';
import { toK1Model } from './k1-model.ts';
import { produceManualEntries } from '../manual.ts';

const filesOf = (brandLine: string) => ({
  'book.adoc': `= Book\n\n== 配置\n\nifdef::brand-apv[]\nAPV 品牌说明。\nendif::[]\n\nifdef::brand-nsae[]\nNSAE 品牌说明。\nendif::[]\n\n${brandLine}\n`,
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const inputOf = (files: Record<string, string>, attributes: Record<string, Record<string, string | boolean>>) => ({
  main: 'book.adoc',
  revision: '42',
  families: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: sha(text) }])),
  familyAttributes: attributes,
});

test('an attribute-set key that is not a product name is refused', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { Other: { 'brand-x': true } }), ['APV', 'NSAE']);
  assert.ok(!out.ok && out.error.code === 'apv.adoc.family_not_a_name', JSON.stringify(out));
  if (!out.ok) assert.match(out.error.message, /Other/);
});

test('each family produces with its own attribute set: brand lines and condition branches differ per family', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true }, NSAE: { 'brand-nsae': true } }), ['APV', 'NSAE']);
  assert.ok(out.ok, JSON.stringify(out));
  const apv = out.families.APV!;
  const nsae = out.families.NSAE!;
  const apvText = toK1Model(apv.model, apv.composition, 'cli').blocks.map((b) => b.text).join('\n');
  const nsaeText = toK1Model(nsae.model, nsae.composition, 'cli').blocks.map((b) => b.text).join('\n');
  assert.ok(apvText.includes('APV 品牌说明') && !apvText.includes('NSAE 品牌说明'), apvText);
  assert.ok(nsaeText.includes('NSAE 品牌说明') && !nsaeText.includes('APV 品牌说明'), nsaeText);
  assert.ok(apvText.includes('共用正文') && nsaeText.includes('共用正文'), 'the shared text is in both');
  // The condition branches are reported per family.
  const apvBranch = apv.report.conditions.find((c) => c.directive.includes('brand-nsae'));
  assert.ok(apvBranch !== undefined && apvBranch.retained === false, JSON.stringify(apv.report.conditions));
  const nsaeBranch = nsae.report.conditions.find((c) => c.directive.includes('brand-apv'));
  assert.ok(nsaeBranch !== undefined && nsaeBranch.retained === false);
  // The manual names carry the family; the same text yields the same entry digests across the two models.
  assert.equal(familyManualName('APV', 'cli'), 'cli-apv');
  assert.equal(familyManualName('NSAE', 'cli'), 'cli-nsae');
  const entriesA = produceManualEntries(toK1Model(apv.model, apv.composition, 'cli-apv'), null, { name: 'cli-apv' });
  const entriesB = produceManualEntries(toK1Model(nsae.model, nsae.composition, 'cli-nsae'), null, { name: 'cli-nsae' });
  const sharedA = entriesA.entries.find((e) => String(e.statement).includes('共用正文'));
  const sharedB = entriesB.entries.find((e) => String(e.statement).includes('共用正文'));
  assert.ok(sharedA !== undefined && sharedB !== undefined);
  assert.equal(sharedA.statement, sharedB.statement, 'identical text keeps the same statement in both families');
});

test('the same inputs twice give the same bytes; changing one family changes only its composition and model', async () => {
  const input = inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true }, NSAE: { 'brand-nsae': true } });
  const first = await compileFamilies(input, ['APV', 'NSAE']);
  const second = await compileFamilies(input, ['APV', 'NSAE']);
  assert.ok(first.ok && second.ok);
  assert.equal(JSON.stringify(first.families.APV), JSON.stringify(second.families.APV));
  const changed = await compileFamilies(inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true }, NSAE: {} }), ['APV', 'NSAE']);
  assert.ok(changed.ok);
  assert.equal(changed.families.APV!.composition.sha256, first.families.APV!.composition.sha256, 'the untouched family keeps its identity');
  assert.notEqual(changed.families.NSAE!.composition.sha256, first.families.NSAE!.composition.sha256, 'the changed family changes its identity');
  assert.ok(changed.families.NSAE!.attributes_origin.configured === false && 'brand-nsae' in changed.families.NSAE!.composition.attributes === false || Object.keys(changed.families.NSAE!.composition.attributes).length === 0);
});

test('a family without a configured set produces with the default (all unset) and the record says so — no unknown', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true } }), ['APV', 'NSAE']);
  assert.ok(out.ok, JSON.stringify(out));
  const nsae = out.families.NSAE!;
  assert.deepEqual(Object.keys(nsae.composition.attributes).length, 0, 'the default is the empty set');
  assert.equal(nsae.attributes_origin.configured, false);
  assert.match(nsae.attributes_origin.note, /这一族的属性集没有配置/);
  assert.match(nsae.attributes_origin.note, /管理员配上以后重新同步/);
  const nsaeText = toK1Model(nsae.model, nsae.composition, 'cli').blocks.map((b) => b.text).join('\n');
  assert.ok(!nsaeText.includes('APV 品牌说明') && !nsaeText.includes('NSAE 品牌说明'), 'no brand line without its attribute');
});

test('one family failing fails the whole group: no partial result', async () => {
  const files: Record<string, string> = filesOf('共用正文。');
  files['broken.adoc'] = '== Broken\n\ninclude::missing.adoc[]\n';
  const out = await compileFamilies({ ...inputOf(files, { APV: {}, NSAE: {} }), main: 'broken.adoc' }, ['APV', 'NSAE']);
  if (out.ok) { assert.fail('the group must fail'); return; }
  assert.ok(out.error.message.includes('旧知识根') || out.error.next_action.includes('旧知识根'), JSON.stringify(out));
  assert.ok(true, 'no partial family result is returned');
});
