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
  'book.adoc': `= Book\n\n== 配置\n\nifdef::brand-famx[]\nFAMX 品牌说明。\nendif::[]\n\nifdef::brand-famy[]\nFAMY 品牌说明。\nendif::[]\n\n${brandLine}\n`,
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const inputOf = (files: Record<string, string>, attributes: Record<string, Record<string, string | boolean>>) => ({
  main: 'book.adoc',
  revision: '42',
  families: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: sha(text) }])),
  familyAttributes: attributes,
});

test('an attribute-set key that is not a product name is refused', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { Other: { 'brand-x': true } }), ['FAMX', 'FAMY']);
  assert.ok(!out.ok && out.error.code === 'famx.adoc.family_not_a_name', JSON.stringify(out));
  if (!out.ok) assert.match(out.error.message, /Other/);
});

test('each family produces with its own attribute set: brand lines and condition branches differ per family', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true }, FAMY: { 'brand-famy': true } }), ['FAMX', 'FAMY']);
  assert.ok(out.ok, JSON.stringify(out));
  const famx = out.families.FAMX!;
  const famy = out.families.FAMY!;
  const famxText = modelOf(famx).blocks.map((b) => b.text).join('\n');
  const famyText = modelOf(famy).blocks.map((b) => b.text).join('\n');
  assert.ok(famxText.includes('FAMX 品牌说明') && !famxText.includes('FAMY 品牌说明'), famxText);
  assert.ok(famyText.includes('FAMY 品牌说明') && !famyText.includes('FAMX 品牌说明'), famyText);
  assert.ok(famxText.includes('共用正文') && famyText.includes('共用正文'), 'the shared text is in both');
  // The condition branches are reported per family.
  const famxBranch = famx.report.conditions.find((c) => c.directive.includes('brand-famy'));
  assert.ok(famxBranch !== undefined && famxBranch.retained === false, JSON.stringify(famx.report.conditions));
  const famyBranch = famy.report.conditions.find((c) => c.directive.includes('brand-famx'));
  assert.ok(famyBranch !== undefined && famyBranch.retained === false);
  // The manual names carry the family; the same text yields the same entry digests across the two models.
  assert.equal(familyManualName('FAMX', 'cli'), 'cli-famx');
  assert.equal(familyManualName('FAMY', 'cli'), 'cli-famy');
  const entriesA = produceManualEntries(modelOf(famx, 'cli-famx'), null, { name: 'cli-famx' });
  const entriesB = produceManualEntries(modelOf(famy, 'cli-famy'), null, { name: 'cli-famy' });
  const sharedA = entriesA.entries.find((e) => String(e.statement).includes('共用正文'));
  const sharedB = entriesB.entries.find((e) => String(e.statement).includes('共用正文'));
  assert.ok(sharedA !== undefined && sharedB !== undefined);
  assert.equal(sharedA.statement, sharedB.statement, 'identical text keeps the same statement in both families');
});

test('the same inputs twice give the same bytes; changing one family changes only its composition and model', async () => {
  const input = inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true }, FAMY: { 'brand-famy': true } });
  const first = await compileFamilies(input, ['FAMX', 'FAMY']);
  const second = await compileFamilies(input, ['FAMX', 'FAMY']);
  assert.ok(first.ok && second.ok);
  assert.equal(JSON.stringify(first.families.FAMX), JSON.stringify(second.families.FAMX));
  const changed = await compileFamilies(inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true }, FAMY: {} }), ['FAMX', 'FAMY']);
  assert.ok(changed.ok);
  assert.equal(changed.families.FAMX!.composition.sha256, first.families.FAMX!.composition.sha256, 'the untouched family keeps its identity');
  assert.notEqual(changed.families.FAMY!.composition.sha256, first.families.FAMY!.composition.sha256, 'the changed family changes its identity');
  // An explicit empty set is a declared set with no attributes: the two facts are asserted apart, so neither hides the
  // other.
  assert.equal(changed.families.FAMY!.attributes.declared, true);
  assert.deepEqual(changed.families.FAMY!.attributes.values, {});
  assert.deepEqual(Object.keys(changed.families.FAMY!.composition.attributes), []);
});

test('a family the parameter names no key for produces with the pack default and says exactly that', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true } }), ['FAMX', 'FAMY']);
  assert.ok(out.ok, JSON.stringify(out));
  const famy = out.families.FAMY!;
  assert.deepEqual(Object.keys(famy.composition.attributes).length, 0, 'the default is the empty set');
  assert.equal(famy.attributes.declared, false);
  assert.deepEqual(Object.keys(famy.attributes.values), []);
  assert.match(famy.attributes.note, /参数里没有这一族的键/);
  assert.match(famy.attributes.note, /包的默认值/);
  assert.match(famy.attributes.note, /组成记录.*variables/);
  // The producer claims no origin it cannot know: the note names the set it used and the Hub's record, nothing else.
  assert.ok(!famy.attributes.note.includes('部署'), famy.attributes.note);
  assert.ok(!famy.attributes.note.includes('集成者'), famy.attributes.note);
  const famyText = modelOf(famy).blocks.map((b) => b.text).join('\n');
  assert.ok(!famyText.includes('FAMX 品牌说明') && !famyText.includes('FAMY 品牌说明'), 'no brand line without its attribute');
});

test('an explicit empty set is a declared set, and a synthetic set is not called deployment data', async () => {
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true }, FAMY: {} }), ['FAMX', 'FAMY']);
  assert.ok(out.ok, JSON.stringify(out));
  const famx = out.families.FAMX!;
  const famy = out.families.FAMY!;
  assert.equal(famy.attributes.declared, true, 'the parameter named this family, with an empty set');
  assert.deepEqual(Object.keys(famy.attributes.values), []);
  assert.equal(famx.attributes.declared, true);
  assert.deepEqual(famx.attributes.values, { 'brand-famx': true });
  for (const family of [famx, famy]) {
    // Where the set came from is the Hub's record; this producer says only which set it used.
    assert.ok(!family.attributes.note.includes('部署数据'), family.attributes.note);
    assert.ok(!family.attributes.note.includes('集成者从源里'), family.attributes.note);
    assert.match(family.attributes.note, /生产器不自己记来源/);
  }
  assert.notEqual(famx.composition.sha256, famy.composition.sha256, 'a different attribute set is a different identity');
});

test('one family failing fails the whole group: a typed reason, no partial result, the old root stays', async () => {
  // Only FAMY fails: a clock attribute in its own set. FAMX's expansion would succeed, and nothing of it is returned.
  const out = await compileFamilies(inputOf(filesOf('共用正文。'), { FAMX: { 'brand-famx': true }, FAMY: { docdate: '2026-10-24' } }), ['FAMX', 'FAMY']);
  assert.equal(out.ok, false, JSON.stringify(out));
  if (out.ok) return;
  assert.equal(out.error.code, 'famx.adoc.clock_attribute', 'the refusal is decided by its code, not by reading a message');
  assert.ok(out.error.message.includes('FAMY'), `the failing family is named: ${out.error.message}`);
  assert.equal('families' in out, false, 'no family result at all, so nothing partial can be applied');
  assert.match(out.error.next_action, /旧知识根/);
});

test('a group every family fails on is refused the same way, by the code of the failure', async () => {
  const files: Record<string, string> = filesOf('共用正文。');
  files['broken.adoc'] = '== Broken\n\ninclude::missing.adoc[]\n';
  const out = await compileFamilies({ ...inputOf(files, { FAMX: {}, FAMY: {} }), main: 'broken.adoc' }, ['FAMX', 'FAMY']);
  assert.equal(out.ok, false, JSON.stringify(out));
  if (out.ok) return;
  assert.equal(out.error.code, 'famx.adoc.include_missing');
  assert.ok(out.error.message.includes('FAMX'), 'the first family that failed is named');
  assert.equal('families' in out, false);
  assert.match(out.error.next_action, /旧知识根/);
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
  const out = await compileFamilies(inputOf(files, { FAMX: { product: 'FAMX' }, FAMY: { product: 'FAMY' } }), ['FAMX', 'FAMY']);
  assert.ok(out.ok, JSON.stringify(out));
  const statements = (family: 'FAMX' | 'FAMY', name: string): string[] => {
    const one = out.families[family]!;
    const mapped = toK1Model(one.model, one.composition, name);
    assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
    const produced = produceAdocEntries(mapped, { name, slot: 'manual' });
    assert.ok(produced.ok, JSON.stringify(produced));
    return produced.entries.map((entry) => String(entry.statement));
  };
  const famx = statements('FAMX', 'cli-famx');
  const famy = statements('FAMY', 'cli-famy');
  assert.ok(famx.includes('本手册介绍 FAMX 的配置。'), JSON.stringify(famx));
  assert.ok(famy.includes('本手册介绍 FAMY 的配置。'), JSON.stringify(famy));
  assert.ok(famx.includes('FAMX 支持热备，见 FAMX 手册。'), JSON.stringify(famx));
  assert.ok(famy.includes('FAMY 支持热备，见 FAMY 手册。'), JSON.stringify(famy));
  assert.ok(!famx.concat(famy).some((statement) => statement.includes('{product}')), 'no placeholder survives into a statement');
  // The fragment stays on the verified source line, which still holds the placeholder: the statement carries what the
  // family's attribute set says (K02 R[4]), the citation carries what the author wrote.
  const one = out.families.FAMX!;
  const mapped = toK1Model(one.model, one.composition, 'cli-famx');
  const block = mapped.model.blocks.find((candidate) => candidate.text === '本手册介绍 FAMX 的配置。');
  assert.ok(block !== undefined, JSON.stringify(mapped.model.blocks.map((candidate) => candidate.text)));
  assert.equal(block.cite.selector, 'l/5');
  const source = files['book.adoc']!.split('\n')[4];
  assert.equal(source, '本手册介绍 {product} 的配置。', 'the cited line is the source line with the placeholder');
});
