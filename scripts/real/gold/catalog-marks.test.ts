// Synthetic XML and source lines only; this oracle imports no executable Hub or pack code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readCatalog, judgeCommand, quoteFromCase } from './catalog-marks.ts';

const tree = `<catalog version="10.8.1"><menu name="widget">
 <item name="port"><arguments><arg name="port" type="U16" limit="[1 - 20]"/></arguments></item>
 <item name="label"><arguments><arg name="name" type="STRING" length="[1 - 4]"/></arguments></item>
 <item name="address"><arguments><arg name="address" type="DOTTEDIP"/></arguments></item>
 <item name="mode"><arguments><arg name="mode" type="STRING" limit="{on|off}"/></arguments></item>
 <item name="optional"><arguments><arg name="first" type="U16" optional="yes"/><arg name="last" type="DOTTEDIP"/></arguments></item>
 <item name="overload"><arguments><arg name="first" type="U16"/></arguments><arguments><arg name="first" type="DOTTEDIP"/><arg name="last" type="STRING"/></arguments></item>
</menu></catalog>`;

test('independently identifies parameter ranges, types and arity in resolved command scope', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'widget port 21').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget port bad').code, 'core.catalog.param_type_mismatch');
  assert.equal(judgeCommand(catalog, 'widget port').code, 'core.catalog.arity_mismatch');
  assert.equal(judgeCommand(catalog, 'widget port 3').code, null);
  assert.equal(judgeCommand(catalog, 'widget port 65536').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget label abcde').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget mode unknown').code, 'core.catalog.param_type_mismatch');
  assert.equal(judgeCommand(catalog, 'widget address 192.0.2.1').code, null);
});
test('unknown heads and prose are out of scope, never not_member gold positives', () => {
  for (const text of ['unlisted command 21', '普通操作说明', '']) {
    const result = judgeCommand(readCatalog(tree), text);
    assert.equal(result.code, null); assert.equal(result.in_scope, false);
  }
});
test('a signature or an optional-argument assignment that matches proves the line valid', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'widget optional 192.0.2.1').code, null);
  assert.equal(judgeCommand(catalog, 'widget optional 3 192.0.2.1').code, null);
  assert.equal(judgeCommand(catalog, 'widget overload 192.0.2.1 name').code, null);
});
test('NFKC, case folding and whitespace folding apply without cutting or inventing arguments', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'ＷＩＤＧＥＴ　ＰＯＲＴ ２１').code, 'core.catalog.param_out_of_range');
  assert.ok(quoteFromCase('ＷＩＤＧＥＴ　ＰＯＲＴ ２１', ['执行 widget   port 21。']));
  assert.ok(!quoteFromCase('widget port 2', ['widget port 21']));
  assert.ok(!quoteFromCase('widget port', ['widget port 21']));
  assert.ok(!quoteFromCase('widget port 21 extra', ['widget port 21']));
});
test('unknown parameter types and unparsed constraints request positioned evidence', () => {
  for (const attribute of ['type="SYNTHETIC_UNKNOWN"', 'type="U16" limit="unparsed-synthetic-rule"']) {
    const result = judgeCommand(readCatalog(`<catalog><item name="sample"><arguments><arg name="a" ${attribute}/></arguments></item></catalog>`), 'sample 1');
    assert.equal(result.code, null); assert.ok(result.requests.length);
    assert.ok(result.requests[0].line! > 0 && result.requests[0].column! > 0);
    assert.ok(result.requests[0].pointer.includes('arg'));
    assert.ok(result.requests[0].fact && result.requests[0].next_action);
  }
});
test('ambiguous error-code choices across matching arities are design gaps rather than guessed codes', () => {
  const xml = '<catalog><item name="sample"><arguments><arg type="U16" limit="[1 - 5]"/></arguments><arguments><arg type="DOTTEDIP"/></arguments></item></catalog>';
  const result = judgeCommand(readCatalog(xml), 'sample 9');
  assert.equal(result.code, null); assert.ok(result.requests.some(r => r.fact.includes('选择规则')));
});
test('the independent reader refuses malformed XML and its source imports no Hub or pack code', () => {
  assert.throws(() => readCatalog('<catalog>'));
  const source = readFileSync(new URL('./catalog-marks.ts', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(?:hub\/|packs\/)/.test(source));
});

const source = { root: { data: { id: 'root', text: '合成文档 10.8.1' }, children: [
  { data: { id: 'case-range', text: 'widget port 21', priority: 2, resource: ['configuration'] }, children: [{ data: { id: 'expected-range', text: '合成期望' }, children: [] }] },
  { data: { id: 'case-negative', text: 'widget port 22', priority: 2, resource: ['Negative'] }, children: [{ data: { id: 'expected-negative', text: '拒绝非法参数' }, children: [] }] },
] } };
const submission = { run: 'run_synthetic', items: [
  { item: 'doc:case-range', handling: 'handled', slots: { findings: [{ text: '合成发现', commands: [{ command: 'widget port 21' }] }] } },
  { item: 'doc:case-negative', handling: 'handled', slots: { findings: [{ text: '合成反向发现', commands: [{ command: 'widget port 22' }] }] } },
] };
const hubMark = (command = 'widget port 21', code = 'core.catalog.param_out_of_range', role = 'subject', pointer = '/phrases/0') => ({ pointer, statement: { verdict: 'refute', code, data: { command } }, qualifier: { nature: 'fact', source_role: role }, warrant: { id: 'catalog@1' } });
const run = (claims: unknown[] = [hubMark()], attribution: string | null = 'author_input') => ({ run: { run: 'run_synthetic' }, latest: { result: { partitions: { delivered: [{ item: 'doc:case-range', requirements: [{ requirement: 'catalog', layers: [{ layer: 'static', terminal: 'violation', ...(attribution ? { attribution } : {}) }], claims }] }, { item: 'doc:case-negative', requirements: [{ requirement: 'catalog', layers: [{ layer: 'static', terminal: 'pass' }], claims: [hubMark('widget port 22')] }] }] } } } });

test('compares attributed cited-command marks and lists negative expected refutations separately', async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  const report = compareCatalogMarks({ treeXml: tree, source, submission, run: run() });
  assert.equal(report.supported.length, 1); assert.equal(report.missed.length, 0); assert.equal(report.extra.length, 0);
  assert.equal(report.negative_expected.length, 1); assert.equal(report.negative_observed.length, 1);
});
for (const [name, claims, missed, extra] of [
  ['lying Hub misses a mark', [], 1, 0],
  ['lying Hub adds a mark', [hubMark(), hubMark('widget port 1')], 0, 1],
  ['lying Hub uses the wrong code', [hubMark('widget port 21', 'core.catalog.arity_mismatch')], 1, 1],
] as const) test(name, async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  const report = compareCatalogMarks({ treeXml: tree, source, submission, run: run([...claims]) });
  assert.equal(report.missed.length, missed); assert.equal(report.extra.length, extra);
});
test('not_member on an unresolved head is an extra mark, never a gold positive', async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  const own = structuredClone(source); own.root.children[0].data.text = 'unlisted command';
  const submitted = structuredClone(submission); submitted.items[0].slots.findings[0].commands[0].command = 'unlisted command';
  const report = compareCatalogMarks({ treeXml: tree, source: own, submission: submitted, run: run([hubMark('unlisted command', 'core.catalog.not_member')]) });
  assert.equal(report.expected.length, 0); assert.equal(report.extra.length, 1);
});
test('a quote from another case, and commands with present, are never added to the independent expected marks', async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  const submitted = structuredClone(submission) as { items: { slots: { findings: { commands: { command: string; present?: boolean }[] }[] } }[] };
  submitted.items[0].slots.findings[0].commands = [{ command: 'widget port 22' }, { command: 'widget port 21', present: true }];
  const report = compareCatalogMarks({ treeXml: tree, source, submission: submitted, run: run([]) });
  assert.equal(report.expected.length, 0); assert.equal(report.missed.length, 0);
  assert.equal(report.summary.not_quoted, 1);
});
test('artifact claims, unattributed refutations and other check pointers cannot inflate the catalog mark score', async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  const report = compareCatalogMarks({ treeXml: tree, source, submission, run: run([hubMark('widget port 21', 'core.catalog.param_out_of_range', 'artifact_under_verification'), hubMark('widget port 21', 'core.catalog.param_out_of_range', 'subject', '/claims/0')]) });
  assert.equal(report.supported.length, 0); assert.equal(report.missed.length, 1); assert.equal(report.extra.length, 0);
  assert.equal(compareCatalogMarks({ treeXml: tree, source, submission, run: run([hubMark()], null) }).supported.length, 0);
});
test('injected cases are excluded and repeated citations are compared as occurrences', async () => {
  const { compareCatalogMarks } = await import('./catalog-marks.ts');
  assert.equal(compareCatalogMarks({ treeXml: tree, source, submission, run: run(), excludeNodes: ['case-range'] }).expected.length, 0);
  const submitted = structuredClone(submission); submitted.items[0].slots.findings[0].commands.push({ command: 'widget port 21' });
  const report = compareCatalogMarks({ treeXml: tree, source, submission: submitted, run: run() });
  assert.equal(report.supported.length, 1); assert.equal(report.missed.length, 1);
});

