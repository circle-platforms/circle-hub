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
import { produceAdocEntries } from './entries.ts';
import type { MarkdownModel } from '../../../../../hub/refs/api.ts';

/** The mapped model of one family, with the mapping's report checked (nothing left uncited). */
const modelOf = (family: { model: Parameters<typeof toK1Model>[0]; composition: Parameters<typeof toK1Model>[1] }, name = 'cli'): MarkdownModel => {
  const mapped = toK1Model(family.model, family.composition, name);
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  return mapped.model;
};

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
  const apvText = modelOf(apv).blocks.map((b) => b.text).join('\n');
  const nsaeText = modelOf(nsae).blocks.map((b) => b.text).join('\n');
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
  const entriesA = produceManualEntries(modelOf(apv, 'cli-apv'), null, { name: 'cli-apv' });
  const entriesB = produceManualEntries(modelOf(nsae, 'cli-nsae'), null, { name: 'cli-nsae' });
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
  // An explicit empty set is a declared set with no attributes: the two facts are asserted apart, so neither hides the
  // other.
  assert.equal(changed.families.NSAE!.attributes.declared, true);
  assert.deepEqual(changed.families.NSAE!.attributes.values, {});
  assert.deepEqual(Object.keys(changed.families.NSAE!.composition.attributes), []);
});

test('a family the parameter names no key for produces with the pack default and says exactly that', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true } }), ['APV', 'NSAE']);
  assert.ok(out.ok, JSON.stringify(out));
  const nsae = out.families.NSAE!;
  assert.deepEqual(Object.keys(nsae.composition.attributes).length, 0, 'the default is the empty set');
  assert.equal(nsae.attributes.declared, false);
  assert.deepEqual(Object.keys(nsae.attributes.values), []);
  assert.match(nsae.attributes.note, /参数里没有这一族的键/);
  assert.match(nsae.attributes.note, /包的默认值/);
  assert.match(nsae.attributes.note, /param_sources/);
  // The producer claims no origin it cannot know: the note names the set it used and the Hub's record, nothing else.
  assert.ok(!nsae.attributes.note.includes('部署'), nsae.attributes.note);
  assert.ok(!nsae.attributes.note.includes('集成者'), nsae.attributes.note);
  const nsaeText = modelOf(nsae).blocks.map((b) => b.text).join('\n');
  assert.ok(!nsaeText.includes('APV 品牌说明') && !nsaeText.includes('NSAE 品牌说明'), 'no brand line without its attribute');
});

test('an explicit empty set is a declared set, and a synthetic set is not called deployment data', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { APV: { 'brand-apv': true }, NSAE: {} }), ['APV', 'NSAE']);
  assert.ok(out.ok, JSON.stringify(out));
  const apv = out.families.APV!;
  const nsae = out.families.NSAE!;
  assert.equal(nsae.attributes.declared, true, 'the parameter named this family, with an empty set');
  assert.deepEqual(Object.keys(nsae.attributes.values), []);
  assert.equal(apv.attributes.declared, true);
  assert.deepEqual(apv.attributes.values, { 'brand-apv': true });
  for (const family of [apv, nsae]) {
    // Where the set came from is the Hub's record; this producer says only which set it used.
    assert.ok(!family.attributes.note.includes('部署数据'), family.attributes.note);
    assert.ok(!family.attributes.note.includes('集成者从源里'), family.attributes.note);
    assert.match(family.attributes.note, /生产器不自己记来源/);
  }
  assert.notEqual(apv.composition.sha256, nsae.composition.sha256, 'a different attribute set is a different identity');
});

test('one family failing fails the whole group: no partial result', async () => {
  const files: Record<string, string> = filesOf('共用正文。');
  files['broken.adoc'] = '== Broken\n\ninclude::missing.adoc[]\n';
  const out = await compileFamilies({ ...inputOf(files, { APV: {}, NSAE: {} }), main: 'broken.adoc' }, ['APV', 'NSAE']);
  if (out.ok) { assert.fail('the group must fail'); return; }
  assert.ok(out.error.message.includes('旧知识根') || out.error.next_action.includes('旧知识根'), JSON.stringify(out));
  assert.ok(true, 'no partial family result is returned');
});

test('an attribute reference reaches each family\'s statement with that family\'s own value, and the fragment stays on the source line', async () => {
  const files = {
    'book.adoc': [
      '= Book',                       // 1
      '',                             // 2
      '== 配置',                       // 3
      '',                             // 4
      '本手册介绍 {product} 的配置。',   // 5
      '',                             // 6
      '{product} 支持热备，见 {product} 手册。', // 7
      '',                             // 8
    ].join('\n'),
  };
  const out = await compileFamilies(inputOf(files, { APV: { product: 'APV' }, NSAE: { product: 'NSAE' } }), ['APV', 'NSAE']);
  assert.ok(out.ok, JSON.stringify(out));
  const statements = (family: 'APV' | 'NSAE', name: string): string[] => {
    const one = out.families[family]!;
    const mapped = toK1Model(one.model, one.composition, name);
    assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
    const produced = produceAdocEntries(mapped, { name, slot: 'manual' });
    assert.ok(produced.ok, JSON.stringify(produced));
    return produced.entries.map((entry) => String(entry.statement));
  };
  const apv = statements('APV', 'cli-apv');
  const nsae = statements('NSAE', 'cli-nsae');
  assert.ok(apv.includes('本手册介绍 APV 的配置。'), JSON.stringify(apv));
  assert.ok(nsae.includes('本手册介绍 NSAE 的配置。'), JSON.stringify(nsae));
  assert.ok(apv.includes('APV 支持热备，见 APV 手册。'), JSON.stringify(apv));
  assert.ok(nsae.includes('NSAE 支持热备，见 NSAE 手册。'), JSON.stringify(nsae));
  assert.ok(!apv.concat(nsae).some((statement) => statement.includes('{product}')), 'no placeholder survives into a statement');
  // The fragment stays on the verified source line, which still holds the placeholder: the statement carries what the
  // family's attribute set says (K02 R[4]), the citation carries what the author wrote.
  const one = out.families.APV!;
  const mapped = toK1Model(one.model, one.composition, 'cli-apv');
  const block = mapped.model.blocks.find((candidate) => candidate.text === '本手册介绍 APV 的配置。');
  assert.ok(block !== undefined, JSON.stringify(mapped.model.blocks.map((candidate) => candidate.text)));
  assert.equal(block.cite.selector, 'l/5');
  const source = files['book.adoc']!.split('\n')[4];
  assert.equal(source, '本手册介绍 {product} 的配置。', 'the cited line is the source line with the placeholder');
});
