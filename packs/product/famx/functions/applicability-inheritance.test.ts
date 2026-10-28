// Applicability inheritance now runs on declared conditions only: a section declares its conditions in a fenced
// `famx-applicability@1` JSON block whose fields must sit inside the closed deployment vocabularies supplied as producer
// options (synthetic here, never shipped product values). Reading conditions out of prose — a chapter title, an opening
// paragraph, a memory phrase — was retired, so prose declares nothing and inherits nothing. Everything below keeps the
// inheritance contract that the prose reader used to feed: scope priority, field merging, override and conflict
// reporting, per-field origins that locate back into the source, and the structural refusal of an invalid declaration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, markdownDocument, utf8 } from '../testing/test-support.ts';
import { textParser } from '../../../../hub/refs/api.ts';
import { ApplicabilitySourceError, produceManualEntries } from './manual.ts';

const options = { components: ['Card-A', 'Card-B'], licenses: ['Permit-A'], deployment_forms: ['Form-A'] };
const GB = 1024 ** 3;

/** One declared condition block, exactly as the pack's grammar reads it: a fenced protocol marker, the exact schema
 * identity, the section it declares for (the source parser's own section path, with `descendants: true`) and the
 * conditions themselves. A block without a resolvable unique section, or with a field outside the grammar, is refused. */
const decl = (section: string[], conditions: Record<string, unknown>): string =>
  '```famx-applicability@1\n' + JSON.stringify({ schema: 'famx-applicability@1', scope: { section, descendants: true }, conditions }) + '\n```';

const outer = decl(['Outer'], { components: { with: ['Card-A'] }, memory: { minimum: { bytes: 8 * GB, inclusive: true }, raw: '内存至少8GB' }, licenses: ['Permit-A'] });
const inner = (conditions: Record<string, unknown>) => decl(['Outer', 'Inner'], conditions);
const source = `# Outer\n\n${outer}\n\n## Middle\n\n### Inner\n\n**demo value** *\\<name\\>*\n\n普通正文。\n\n| 参数 | 说明 |\n| --- | --- |\n| mode | ordinary |\n`;
const result = (text = source) => produceManualEntries(markdown(text), null, options);
type State = { schema: string; grammar: string; declaration_status: string | null; judgment_status: string; declared_fields: string[]; conflicted_fields: string[]; criteria_digest: string };
const stateOf = (entry: { data: Record<string, unknown> }): State => entry.data.applicability_state as State;

const body = (out: ReturnType<typeof result>, statement = '普通正文。') => {
  const found = out.entries.find((entry) => entry.statement === statement);
  assert.ok(found, JSON.stringify(out.entries.map((entry) => entry.statement)).slice(0, 300));
  return found;
};

test('a declared condition reaches third-level text, signatures and table rows', () => {
  const out = result();
  const entries = [body(out), out.entries.find((entry) => entry.statement.includes('demo value')), out.entries.find((entry) => entry.statement.includes('ordinary'))];
  for (const entry of entries) {
    assert.ok(entry, JSON.stringify(out.entries.map((row) => row.statement)).slice(0, 300));
    assert.deepEqual(entry.applicability?.components, { with: ['Card-A'] });
    assert.equal(entry.applicability?.memory?.minimum?.bytes, 8 * GB);
    assert.deepEqual(entry.applicability?.licenses, ['Permit-A']);
    assert.deepEqual(new Set(entry.applicability?.inherited), new Set(['components', 'memory', 'licenses']));
    assert.ok(entry.fragments.slice(1).some((fragment) => fragment.applicability?.length));
  }
  // The state describes the entry's effective conditions, so an inheriting leaf reads `declared` with the inherited
  // fields; `applicability.inherited` is what says they came from above rather than from its own section.
  assert.equal(stateOf(body(out)).declaration_status, 'declared');
  assert.deepEqual(stateOf(body(out)).declared_fields, ['components', 'memory', 'licenses']);
  assert.equal(stateOf(body(out)).judgment_status, 'unjudged', 'no judgment here: a claim needs a verified quote');
});

test('every inherited origin reads the declared block and names only the corresponding field', async () => {
  const out = result();
  const document = markdownDocument(source);
  const lines = textParser.parse(utf8(source));
  const entry = body(out);
  let seen = 0;
  for (const fragment of entry.fragments.slice(1)) {
    const located = (await (fragment.parser === 'text@1' ? lines : document).locate(fragment.selector));
    assert.ok(located, fragment.selector);
    for (const origin of fragment.applicability ?? []) {
      seen++;
      assert.ok(origin.declaration[origin.field], JSON.stringify(origin));
      assert.ok(origin.section.length);
      assert.ok(located.text.includes('famx-applicability@1'), located.text.slice(0, 120));
    }
  }
  assert.ok(seen > 0, 'the inherited fields carry their origins');
});

test('a declaration names its section path, so renaming the chapter refuses until the declaration follows', () => {
  // The scope is part of the declaration: after a rename the path no longer resolves uniquely, and the pack refuses
  // instead of attaching the condition to whatever section happens to be there. Updating the declaration restores the
  // same inherited content with provenance that reads the renamed chapter.
  assert.throws(
    () => result(source.replace('# Outer', '# Renamed')),
    (error: unknown) => error instanceof ApplicabilitySourceError && /章节路径不存在或不唯一/.test(error.message) && /下一步/.test(error.message),
  );
  const renamed = source.replace('# Outer', '# Renamed').replace('{"schema":"famx-applicability@1","scope":{"section":["Outer"]', '{"schema":"famx-applicability@1","scope":{"section":["Renamed"]');
  const before = body(result());
  const after = body(result(renamed));
  assert.deepEqual(after.applicability, before.applicability, 'the inherited conditions are unchanged by a rename');
  assert.deepEqual(before.data.section_path, ['Outer', 'Middle', 'Inner']);
  assert.deepEqual(after.data.section_path, ['Renamed', 'Middle', 'Inner']);
  assert.notDeepEqual(after.fragments, before.fragments, 'provenance reads the renamed chapter');
  assert.equal(JSON.stringify(result()), JSON.stringify(result()));
});

test('an inner declaration takes scope priority, different fields merge and overrides remain reported', () => {
  const out = result(`# Outer\n\n${outer}\n\n## Inner\n\n${inner({ components: { with: ['Card-B'] } })}\n\n普通正文。\n`);
  const entry = body(out);
  assert.deepEqual(entry.applicability?.components, { with: ['Card-B'] }, 'the inner declaration wins its own field');
  assert.equal(entry.applicability?.memory?.minimum?.bytes, 8 * GB, 'a field the inner section does not declare is inherited');
  assert.deepEqual(entry.applicability?.licenses, ['Permit-A']);
  assert.ok(out.applicability_report?.overrides.some((row) => row.field === 'components'), JSON.stringify(out.applicability_report));
});

test('same-section conflicts retain both values and origins, omit that field and never fall back outward', () => {
  const out = result(`# Outer\n\n${outer}\n\n## Inner\n\n${inner({ components: { with: ['Card-A'] } })}\n\n${inner({ components: { with: ['Card-B'] } })}\n\n### Leaf\n\n普通正文。\n`);
  const entry = body(out);
  assert.equal(entry.applicability?.components, undefined, 'a conflicted field is omitted rather than resolved by a guess');
  assert.deepEqual(stateOf(entry).conflicted_fields, ['components']);
  const origins = entry.fragments.flatMap((fragment) => fragment.applicability ?? []).filter((origin) => origin.field === 'components' && !origin.superseded);
  assert.equal(origins.length, 2);
  assert.ok(origins.every((origin) => origin.conflict));
  assert.deepEqual(new Set(origins.flatMap((origin) => origin.declaration.components?.with ?? [])), new Set(['Card-A', 'Card-B']));
  assert.equal(out.applicability_report?.conflicts.length, 1);
  assert.ok(!entry.applicability?.memory === false, 'the other declared fields still reach the leaf');
});

test('prose declares nothing and never blocks a declared condition above it', () => {
  for (const prose of ['装有 Card-B 时。', '没有输出时，检查端口状态。', '内存至少 4GB。', '需要 Permit-A 许可。', '装有 Card-A、Unknown 时。']) {
    const out = result(`# Outer\n\n${outer}\n\n## Inner\n\n${prose}\n\n### Leaf\n\n普通正文。\n`);
    const entry = body(out);
    assert.deepEqual(entry.applicability?.components, { with: ['Card-A'] }, prose);
    assert.equal(entry.applicability?.memory?.minimum?.bytes, 8 * GB, prose);
    // The prose paragraph inherits like every other entry of the section, and inheriting is not declaring: its own
    // applicability state stays undeclared with no declared field.
    const sentence = out.entries.find((row) => row.statement === prose);
    assert.ok(sentence, prose);
    // Every effective field of the sentence is an inherited one: the sentence itself declared nothing.
    assert.deepEqual(new Set(sentence.applicability?.inherited ?? []), new Set(['components', 'memory', 'licenses']), prose);
  }
});

test('an overridden outer declaration stays reported instead of being dropped silently', () => {
  const out = result(`# Outer\n\n${decl(['Outer'], { components: { with: ['Card-A'] } })}\n\n## Inner\n\n${inner({ components: { with: ['Card-B'] } })}\n\n普通正文。\n`);
  const entry = body(out);
  assert.deepEqual(entry.applicability?.components, { with: ['Card-B'] }, 'the inner declaration is what the leaf reads');
  const override = out.applicability_report?.overrides.find((row) => row.field === 'components');
  assert.ok(override, JSON.stringify(out.applicability_report));
  assert.deepEqual(override.values.map((value: any) => value?.components ?? value), [{ with: ['Card-A'] }, { with: ['Card-B'] }], JSON.stringify(override));
});

test('empty closed sets refuse a declaration instead of inventing one, and prose still declares nothing', () => {
  const out = produceManualEntries(markdown('# Outer\n\n## Inner\n\n没有输出时需要管理员许可，适用于 Form-A 部署形态。\n\n普通正文。\n'), null, { components: [], licenses: [], deployment_forms: [] });
  assert.ok(out.entries.every((entry) => entry.applicability === null));
  assert.ok(out.entries.every((entry) => !entry.fragments.some((fragment) => fragment.applicability?.length)));
  assert.throws(
    () => produceManualEntries(markdown(`# Outer\n\n${decl(['Outer'], { licenses: ['Permit-A'] })}\n\n普通正文。\n`), null, { components: [], licenses: [], deployment_forms: [] }),
    (error: unknown) => error instanceof ApplicabilitySourceError && /闭集为空/.test(error.message) && /下一步/.test(error.message),
  );
});

test('a declaration outside the grammar is refused with the missing fact and the author exit', () => {
  const cases: Array<[string, string]> = [
    ['a field the grammar does not declare', decl(['Outer'], { components: { with: ['Card-A'] }, colour: 'red' })],
    ['a value outside the closed vocabulary', decl(['Outer'], { components: { with: ['Card-X'] } })],
    ['an explicit null instead of no condition', decl(['Outer'], { licenses: null })],
    ['a memory bound that is not a safe integer', decl(['Outer'], { memory: { minimum: { bytes: 1.5, inclusive: true } } })],
    ['a memory bound without its source text', decl(['Outer'], { memory: { minimum: { bytes: 8 * GB, inclusive: true } } })],
    ['an undeclared key beside the schema', '```famx-applicability@1\n{"schema":"famx-applicability@1","scope":{"section":["Outer"],"descendants":true},"conditions":{"licenses":["Permit-A"]},"note":"x"}\n```'],
    ['a missing scope', '```famx-applicability@1\n{"schema":"famx-applicability@1","conditions":{"licenses":["Permit-A"]}}\n```'],
    ['a scope that does not name descendants', '```famx-applicability@1\n{"schema":"famx-applicability@1","scope":{"section":["Outer"]},"conditions":{"licenses":["Permit-A"]}}\n```'],
    ['a section path that does not exist', decl(['Nowhere'], { licenses: ['Permit-A'] })],
    ['empty conditions', decl(['Outer'], {})],
  ];
  for (const [label, block] of cases) {
    assert.throws(
      () => produceManualEntries(markdown(`# Outer\n\n${block}\n\n普通正文。\n`), null, options),
      (error: unknown) => error instanceof ApplicabilitySourceError && /结构违规|闭集|未声明字段|作用域|章节路径|conditions/.test(error.message) && /下一步/.test(error.message),
      label,
    );
  }
  assert.throws(
    () => produceManualEntries(markdown('# Outer\n\n```famx-applicability@1\n{"schema":"famx-applicability@1"\n```\n\n普通正文。\n'), null, options),
    (error: unknown) => error instanceof ApplicabilitySourceError && /不是合法 JSON/.test(error.message),
    'an unreadable declaration is refused, not skipped',
  );
});
