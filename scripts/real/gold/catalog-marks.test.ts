import type { Attribution, Verdict, Nature, SourceRole, Layer, StaticTerminal, Acceptance, ItemHandling } from '../../../contracts/generated/vocabulary.ts';
// Synthetic XML and source lines only; this oracle imports no executable Hub or pack code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readCatalog, judgeCommand, quoteFromCase, type EvidenceRequest } from './catalog-marks.ts';

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
  assert.ok(quoteFromCase('ＷＩＤＧＥＴ　ＰＯＲＴ ２１', ['widget   port 21']));
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
const staticFixture = (terminal:StaticTerminal, attribution?:Attribution) => ({layer:'static' satisfies Layer,terminal,...(attribution === undefined ? {} : {attribution})});
const hubMark = (command = 'widget port 21', code = 'core.catalog.param_out_of_range', role: SourceRole = 'subject', pointer = '/phrases/0') => ({ pointer, statement: { verdict: 'refute' satisfies Verdict, code, data: { command } }, qualifier: { nature: 'fact' satisfies Nature, source_role: role }, warrant: { id: 'catalog@1' } });
const run = (claims: unknown[] = [hubMark()], attribution: Attribution | null = 'author_input') => ({ run: { run: 'run_synthetic' }, latest: { result: { partitions: { delivered: [{ item: 'doc:case-range', requirements: [{ requirement: 'catalog', layers: [staticFixture('violation',attribution ?? undefined)], claims }] }, { item: 'doc:case-negative', requirements: [{ requirement: 'catalog', layers: [staticFixture('violation')], claims: [hubMark('widget port 22')] }] }] } } } });

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

import { createHash } from 'node:crypto';
import { canonicalJson } from './compile-check.ts';
const table = JSON.parse(readFileSync(new URL('../../../packs/workflow/case-review/tables/cited-commands.json', import.meta.url), 'utf8'));
const tableBytes = Buffer.from(JSON.stringify(table));
const packManifest = {schema:'pack@1', id:'case-review', version:'1.0.0', files:[{path:'tables/cited-commands.json',sha256:createHash('sha256').update(tableBytes).digest('hex'),size:tableBytes.length}]};
const bytes = Buffer.from(JSON.stringify(submission));
const sourceBytes = Buffer.from(JSON.stringify(source));
const receiptRun = () => {
  const value = run() as unknown as { run: Record<string, unknown>; latest: { result: Record<string, unknown> } };
  value.run.pack = 'case-review@1.0.0'; value.run.pack_digest = createHash('sha256').update(canonicalJson(packManifest)).digest('hex');
  value.run.root = 'a'.repeat(64);
  value.run.sources = [{ role: 'subject', reference: `src:${createHash('sha256').update(sourceBytes).digest('hex')}` }];
  Object.assign(value.latest.result, { run: 'run_synthetic', acceptance: 'accepted', submission: createHash('sha256').update(canonicalJson(submission)).digest('hex') });
  return value;
};

test('canonical submission identity accepts whitespace and key-order changes', async () => {
  const { catalogMarks } = await import('./catalog-marks.ts');
  const value = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: receiptRun(), submissionBytes: bytes, table });
  assert.equal(value.summary.supported, 1); assert.equal(value.requests.length, 0);
  const changed = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: receiptRun(), submissionBytes: Buffer.concat([bytes, Buffer.from('\n')]), table });
  assert.equal(changed.requests.length, 0);
  assert.equal(changed.supported.length, 1);
});
test('missing original bytes or the latest accepted digest creates an actionable positioned design gap', async () => {
  const { catalogMarks } = await import('./catalog-marks.ts');
  const missing = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: receiptRun(), table });
  assert.ok(missing.requests.some(r => r.next_action.includes('get_nodes') && r.next_action.includes('--submission')));
  const value = receiptRun(); delete value.latest.result.submission;
  const gap = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: value, submissionBytes: bytes, table });
  assert.ok(gap.requests.some(r => r.pointer === '/latest/result/submission'));
});
test('scope drift refuses adjudication and states that only resolved is implemented', async () => {
  const { catalogMarks } = await import('./catalog-marks.ts');
  const changed = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: receiptRun(), submissionBytes: bytes, table: { ...table, scope: 'all' } });
  assert.equal(changed.expected.length, 0);
  assert.ok(changed.requests.some(r => r.pointer === '/scope' && r.fact.includes('resolved')));
});
test('source identity, malformed submissions and missing case evidence are never accepted as zero errors', async () => {
  const { catalogMarks } = await import('./catalog-marks.ts');
  const badSource = catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes: Buffer.from(JSON.stringify({ ...source, unused: true })), run: receiptRun(), submissionBytes: bytes, table });
  assert.ok(badSource.requests.some(r => r.input === 'source'));
  const value = receiptRun(); value.latest.result.submission = createHash('sha256').update('{broken').digest('hex');
  assert.ok(catalogMarks({ packManifest, tableBytes, argumentTypes: [], treeXml: tree, sourceBytes, run: value, submissionBytes: Buffer.from('{broken'), table }).requests.length);
});

import { mkdtempSync, readFileSync as read, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const privateInputs = (t: { after(fn: () => void): void }) => {
  const directory = mkdtempSync(join(tmpdir(), 'gold-catalog-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = { tree: join(directory, 'tree.xml'), source: join(directory, 'source.json'), run: join(directory, 'run.json'), submission: join(directory, 'submission.json'), manifest: join(directory, 'pack.json'), types: join(directory, 'types.json'), table: join(directory, 'table.json'), out: join(directory, 'report') };
  writeFileSync(files.manifest, JSON.stringify(packManifest));
  writeFileSync(files.types, '[]');
  writeFileSync(files.tree, tree); writeFileSync(files.source, sourceBytes); writeFileSync(files.run, JSON.stringify(receiptRun())); writeFileSync(files.submission, bytes); writeFileSync(files.table, JSON.stringify(table));
  return files;
};
const cliArgs = (files: ReturnType<typeof privateInputs>) => ['--manifest', files.manifest, '--argument-types', files.types, '--tree', files.tree, '--source', files.source, '--run', files.run, '--submission', files.submission, '--table', files.table, '--out', files.out];

test('CLI writes detailed evidence only to private immutable files and screens counts and digests', async t => {
  const { main } = await import('./catalog-marks.ts'); const files = privateInputs(t), screen: string[] = [];
  assert.equal(main(cliArgs(files), line => screen.push(line)), 0);
  assert.equal(statSync(join(files.out, 'catalog-marks.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(files.out, 'evidence-requests.json')).mode & 0o777, 0o600);
  assert.ok(JSON.parse(read(join(files.out, 'catalog-marks.json'), 'utf8')).supported.length);
  const visible = screen.join('\n').replace(/[a-f0-9]{64}/g, '<digest>');
  for (const value of ['case-range', 'widget port', 'run_synthetic', 'core.catalog', '10.8.1']) assert.ok(!visible.includes(value));
  const original = read(join(files.out, 'catalog-marks.json'), 'utf8');
  assert.equal(main(cliArgs(files), () => {}), 1); assert.equal(read(join(files.out, 'catalog-marks.json'), 'utf8'), original);
});
test('unknown parameter types exit one and preserve XML position in the supplement request', async t => {
  const { main } = await import('./catalog-marks.ts'); const files = privateInputs(t);
  writeFileSync(files.tree, tree.replace('type="U16"', 'type="SYNTHETIC_UNKNOWN"'));
  assert.equal(main(cliArgs(files), () => {}), 1);
  const requests = JSON.parse(read(join(files.out, 'evidence-requests.json'), 'utf8'));
  assert.ok(requests.some((r: EvidenceRequest) => r.input === 'tree' && r.pointer.includes('@type') && r.line! > 0 && r.column! > 0));
});
test('scope drift and missing submission bytes exit one with a request, never as a successful zero-mark report', async t => {
  const { main } = await import('./catalog-marks.ts'); const files = privateInputs(t);
  writeFileSync(files.table, JSON.stringify({ ...table, scope: 'all' }));
  assert.equal(main(cliArgs(files), () => {}), 1);
  assert.ok(JSON.parse(read(join(files.out, 'evidence-requests.json'), 'utf8')).some((r: EvidenceRequest) => r.pointer === '/scope'));
});
test('output in a Git checkout and malformed input cannot leak file paths or source values', async t => {
  const { main } = await import('./catalog-marks.ts'); const files = privateInputs(t), screen: string[] = [];
  const args = cliArgs(files); args[args.length - 1] = fileURLToPath(new URL('./forbidden-output', import.meta.url));
  assert.equal(main(args, line => screen.push(line)), 1);
  assert.ok(!screen.join('').includes(files.source));
});

test('malformed receipt fields never appear on the screen as if they were digests', async t => {
  const { main } = await import('./catalog-marks.ts'); const files = privateInputs(t), screen: string[] = [];
  const bad = receiptRun(); bad.run.root = 'synthetic-private-root-value'; writeFileSync(files.run, JSON.stringify(bad));
  assert.equal(main(cliArgs(files), line => screen.push(line)), 1);
  assert.ok(!screen.join('').includes('synthetic-private-root-value'));
});

test('real-shaped Latin-1 trees tolerate stray help quotes and count unnamed items locally', async () => {
  const { decodeCatalog } = await import('./catalog-marks.ts');
  const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope><menu name="widget"><item name="port" help_string="Type "text" café"><arguments><arg name="n" type="U16"/></arguments></item><item name=""><arguments><arg type="UNKNOWN"/></arguments></item></menu></scope></commands>';
  const catalog = readCatalog(decodeCatalog(Buffer.from(xml, 'latin1')));
  assert.equal(catalog.unnamedItems, 1);
  assert.equal(catalog.commands.length, 1);
  assert.equal(judgeCommand(catalog, 'widget port 2').code, null);
  assert.equal(judgeCommand(catalog, 'widget port 2').requests.length, 0);
});

test('help_string names host forms and explicit locked-root type declarations take precedence', () => {
  const xml = '<commands><item name="connect"><arguments><arg name="target" type="DOTTEDIP" help_string="address or host name"/></arguments></item></commands>';
  assert.equal(judgeCommand(readCatalog(xml), 'connect host.example').requests.length, 0);
  assert.equal(judgeCommand(readCatalog(xml), 'connect host.example').code, null);
  const overridden = readCatalog(xml, [{command:'connect',position:1,type:'U16',origin:'synthetic declaration'}]);
  assert.equal(judgeCommand(overridden, 'connect host.example').code, 'core.catalog.param_type_mismatch');
});

test('malformed declaration arrays have a fixed input reason at their own boundary', async () => {
 const {readArgumentTypes,CatalogInputError}=await import('./catalog-marks.ts');
 for(const value of ['{broken','{}','[null]','[{"command":"sample","position":0,"type":"U16","origin":"synthetic"}]']) {
  assert.throws(()=>readArgumentTypes(Buffer.from(value)),e=>e instanceof CatalogInputError && e.reason==='argument_types');
 }
 assert.deepEqual(readArgumentTypes(Buffer.from('[]')),[]);
});

test('expected negative citations stay separate when an unexpected model claim owns the layer attribution', async () => {
  const {compareCatalogMarks}=await import('./catalog-marks.ts');
  const shown=run() as any;
  const negative=shown.latest.result.partitions.delivered[1].requirements[0];
  negative.layers=[{layer:'static',terminal:'violation',attribution:'producer_error'}];
  negative.claims.push(hubMark('widget port 22','core.catalog.membership_contradicted','subject','/claims/0'));
  const report=compareCatalogMarks({treeXml:tree,source,submission,run:shown});
  assert.equal(report.negative_observed.length,1); assert.equal(report.extra.length,0);
  const missing=compareCatalogMarks({treeXml:tree,source,submission,run:run([hubMark()],null)});
  assert.equal(missing.extra.length,1); assert.equal(missing.missed.length,1);
});

test('undeclared constraint and token choices request positioned rules instead of guessing codes', () => {
  for (const [attr,line] of [['type="U16" limit="20"','sample 25'],['type="STRING" limit="5"','sample abcdef'],['type="U16" limit="{auto|1|2}"','sample auto'],['type="IPMASK"','sample 200'],['type="STRING" length="[1 - 2]"','sample "a\\b"']]) {
    const result=judgeCommand(readCatalog(`<commands><item name="sample"><arguments><arg ${attr}/></arguments></item></commands>`),line);
    assert.equal(result.code,null,line); assert.ok(result.requests.length,line);
    assert.ok(result.requests.every(r=>r.pointer && r.next_action && r.line));
  }
});

test('fallback cases without citations do not block a run and position selectors bind cited cases', async () => {
  const {compareCatalogMarks}=await import('./catalog-marks.ts');
  const own=structuredClone(source); own.root.children[0].data.id='duplicate'; own.root.children[1].data.id='duplicate';
  const empty={items:[{item:'fallback',handling:'handled',slots:{findings:[]}}]};
  const untouched=compareCatalogMarks({treeXml:tree,source:own,submission:empty,run:{latest:{result:{partitions:{}}}}});
  assert.equal(untouched.requests.length,0);
  const submitted={items:[{...submission.items[0],item:'fallback'}]};
  const shown=run() as any;
  shown.run.items=[{id:'fallback',location:`src:${'b'.repeat(64)}/kityminder@1/i/0`}];
  shown.latest.result.partitions.delivered=[{item:'fallback',requirements:[{requirement:'catalog',layers:[{layer:'static',terminal:'violation',attribution:'author_input'}],claims:[hubMark()]}]}];
  const compared=compareCatalogMarks({treeXml:tree,source:own,submission:submitted,run:shown});
  assert.equal(compared.requests.length,0); assert.equal(compared.supported.length,1);
});

test('partial argument citations request a declared boundary rule rather than sharing the checked cut algorithm', async () => {
  const {compareCatalogMarks}=await import('./catalog-marks.ts');
  const own=structuredClone(source); own.root.children[0].data.text='widget port 21,22';
  const report=compareCatalogMarks({treeXml:tree,source:own,submission,run:run()});
  assert.ok(report.requests.some(r=>r.input==='table' && r.pointer==='/match/boundary' && r.next_action));
  assert.equal(report.expected.length,0); assert.equal(report.extra.length,0);
});

test('the table bytes and canonical manifest must bind to the run locked pack', async () => {
 const {catalogMarks}=await import('./catalog-marks.ts');
 for(const changed of [{packManifest:{...packManifest,version:'other'}},{tableBytes:Buffer.concat([tableBytes,Buffer.from(' ')])}]) {
 const report=catalogMarks({packManifest,tableBytes,argumentTypes:[],treeXml:tree,sourceBytes,run:receiptRun(),submissionBytes:bytes,table,...changed});
 assert.equal(report.expected.length,0); assert.ok(report.requests.some(r=>r.input==='manifest' || r.input==='table'));
 }
});

test('missing Hub pointer or command is an output mismatch rather than a missing gold input', async () => {
 const {compareCatalogMarks}=await import('./catalog-marks.ts');
 for(const field of ['pointer','command']) {
  const mark=hubMark() as any; if(field==='pointer')delete mark.pointer; else delete mark.statement.data.command;
  const report=compareCatalogMarks({treeXml:tree,source,submission,run:run([mark])});
  assert.equal(report.requests.length,0); assert.equal(report.missed.length,1); assert.equal(report.extra.length,1);
  assert.match(report.extra[0].output_error ?? '',/输出缺字段/);
 }
});

test('nondefault projection priorities request their exact run parameter positions', async () => {
 const {catalogMarks}=await import('./catalog-marks.ts');
 for(const key of ['case_priority','group_priority','precondition_priority']) {
  const shown=receiptRun(); shown.run.parameters={[key]:9};
  const report=catalogMarks({packManifest,tableBytes,argumentTypes:[],treeXml:tree,sourceBytes,run:shown,submissionBytes:bytes,table});
  assert.equal(report.expected.length,0); assert.ok(report.requests.some(r=>r.pointer==='/run/parameters/'+key));
 }
});

test('catalog comparison vocabulary constants are generated-type constrained', async () => {
 const module=await import('./catalog-marks.ts');
 assert.equal(module.CATALOG_VALUES?.refute,'refute');
 const source=readFileSync(new URL('./catalog-marks.ts',import.meta.url),'utf8');
 assert.ok(!/\.(?:verdict|nature|source_role|acceptance|handling)\s*!?==?\s*'(?:refute|fact|subject|accepted|skipped)'/.test(source));
});

// @ts-expect-error Values cannot drift outside the generated axis.
const invalidVerdict: Verdict = 'invented_catalog_verdict';
void invalidVerdict;

test('unexpected oracle defects propagate while known input refusals carry fixed reasons', async () => {
 const {catalogMarks,CatalogInputError}=await import('./catalog-marks.ts');
 const defect=new Error('不是脑图对象 private synthetic bug');
 const broken={get root(){throw defect;}};
 assert.throws(()=>catalogMarks({packManifest,tableBytes,argumentTypes:[],treeXml:tree,sourceBytes,run:receiptRun(),submissionBytes:bytes,table, get excludeNodes(): never {throw defect;}}),e=>e===defect);
 assert.throws(()=>readCatalog('<commands>'),e=>e instanceof CatalogInputError && e.reason==='tree_structure');
 void broken;
});

test('missing submission identity asks for its canonical digest rather than an unavailable original-byte digest', async () => {
 const {catalogMarks}=await import('./catalog-marks.ts');const shown=receiptRun();delete shown.latest.result.submission;
 const report=catalogMarks({packManifest,tableBytes,argumentTypes:[],treeXml:tree,sourceBytes,run:shown,submissionBytes:bytes,table});
 const gap=report.requests.find(r=>r.pointer==='/latest/result/submission')!;assert.match(gap.fact,/规范 JSON/);assert.ok(!gap.fact.includes('原件字节'));
});

test('closure B2 a boundary gap leaves the entire item comparison unscored in either citation order', async () => {
 const {compareCatalogMarks}=await import('./catalog-marks.ts');
 for(const reverse of [false,true]) {
  const own=structuredClone(source);own.root.children[0].data.text='配置 widget port 21 后检查\nwidget port 25';
  const submitted=structuredClone(submission);const commands=[{command:'widget port 21'},{command:'widget port 25'}];if(reverse)commands.reverse();submitted.items[0].slots.findings[0].commands=commands;
  const report=compareCatalogMarks({treeXml:tree,source:own,submission:submitted,run:run([hubMark('widget port 25',undefined,undefined,reverse?'/phrases/0':'/phrases/1')])});
  assert.equal(report.missed.length,0);assert.equal(report.extra.length,0);assert.equal(report.expected.length,0);
  assert.equal(report.summary.not_compared,1);assert.equal(report.not_compared[0].expected.length,1);assert.equal(report.not_compared[0].hub.length,1);
 }
});

test('closure B3 union expansion keeps at most 32 alternatives per argument list', () => {
 const args=Array.from({length:6},()=>'<arg type="IPADDR"/>').join('');
 const catalog=readCatalog(`<catalog><menu name="demo"><item name="acl mesh"><arguments>${args}</arguments></item></menu></catalog>`);
 const words=['192.0.2.1','192.0.2.2','192.0.2.3','192.0.2.4','192.0.2.5','host.example'];
 const answer=judgeCommand(catalog,'demo acl mesh '+words.join(' '));assert.equal(answer.code,null);assert.deepEqual(answer.requests,[]);
 words[4]='host.example';assert.equal(judgeCommand(catalog,'demo acl mesh '+words.join(' ')).code,'core.catalog.param_type_mismatch');
});

for(const [attribute,type,value,position] of [
 ['length="3"','U16','1234','/@length'],['length="[1 - 2]"','U32','123','/@length'],
 ['length="9"','DOTTEDIP','192.0.2.100','/@length'],['length="9"','IPADDR','192.0.2.100','/@length'],
 ['length="9"','IPMASK','24','/@length'],['limit="[70000 - 80000]"','U16','100','/@limit'],
] as const) test(`closure B4 unresolved typed constraint ${type} ${attribute}`,()=>{
 const result=judgeCommand(readCatalog(`<catalog><item name="sample"><arguments><arg type="${type}" ${attribute}/></arguments></item></catalog>`),'sample '+value);
 assert.equal(result.code,null);assert.ok(result.requests.some(r=>r.pointer.endsWith(position)));assert.ok(result.requests.every(r=>r.line!>0));
});
test('closure B4 unnamed menu descendants require a positioned path rule',()=>{
 const result=judgeCommand(readCatalog('<catalog><menu name=""><item name="ghost"><arguments><arg type="U16" limit="[1 - 5]"/></arguments></item></menu></catalog>'),'ghost 9');
 assert.equal(result.code,null);assert.ok(result.requests.some(r=>r.pointer==='/catalog[1]/menu[1]'));
});

test('closure B6 optional assignment paths retain one positioned request per unresolved mask',()=>{
 const catalog=readCatalog('<catalog><item name="route"><arguments><arg type="IPMASK"/>'+Array.from({length:10},()=>'<arg type="STRING" optional="yes"/>').join('')+'</arguments></item></catalog>');
 const result=judgeCommand(catalog,'route 200 a a a a a');assert.equal(result.code,null);assert.equal(result.requests.length,1);
});

test('closure B6 mask type failures and impossible arities need no ambiguous code rule',()=>{
 const catalog=readCatalog('<catalog><item name="route"><arguments><arg type="DOTTEDIP"/><arg type="IPMASK"/><arg type="DOTTEDIP"/></arguments></item></catalog>');
 for(const value of ['abc','255.0.255.0']) {
  const type=judgeCommand(catalog,`route 192.0.2.0 ${value} 192.0.2.1`);assert.equal(type.code,'core.catalog.param_type_mismatch');assert.deepEqual(type.requests,[]);
  for(const line of [`route 192.0.2.0 ${value}`,`route 192.0.2.0 ${value} 192.0.2.1 5`]){const arity=judgeCommand(catalog,line);assert.equal(arity.code,'core.catalog.arity_mismatch');assert.deepEqual(arity.requests,[]);}
 }
 for(const value of ['200','-1']) {
  assert.ok(judgeCommand(catalog,`route 192.0.2.0 ${value} 192.0.2.1`).requests.length);
  const arity=judgeCommand(catalog,`route 192.0.2.0 ${value}`);assert.equal(arity.code,'core.catalog.arity_mismatch');assert.deepEqual(arity.requests,[]);
 }
});

test('closure B7 rule gaps require a declaration and oracle implementation before rerun',async()=>{
 const {compareCatalogMarks}=await import('./catalog-marks.ts');
 const specimens=[['U16','limit="5"','9'],['U16','optional="perhaps"','9'],['U16','limit="{1|2}"','9'],['IPMASK','','200'],['UNKNOWN','','9'],['U16','length="3"','1234'],['U16','limit="[70000 - 80000]"','100']];
 const requests=specimens.flatMap(([type,attr,value])=>judgeCommand(readCatalog(`<catalog><item name="sample"><arguments><arg type="${type}" ${attr}/></arguments></item></catalog>`),'sample '+value).requests);
 requests.push(...judgeCommand(readCatalog('<catalog><item name="sample"><arguments><arg type="STRING"/></arguments></item></catalog>'),'sample \\value').requests);
 requests.push(...judgeCommand(readCatalog('<catalog><item name="sample"><arguments><arg type="U16"/></arguments><arguments><arg type="DOTTEDIP"/></arguments></item></catalog>'),'sample 70000').requests);
 const own=structuredClone(source);own.root.children[0].data.text='配置 widget port 21 后检查';requests.push(...compareCatalogMarks({treeXml:tree,source:own,submission,run:run()}).requests);
 assert.ok(requests.length>=10);
 for(const r of requests){assert.match(r.next_action,/README/);assert.match(r.next_action,/金标准实现/);assert.match(r.next_action,/重跑/);}
 assert.ok(requests.some(r=>r.next_action.includes('hub/rules/README.md') && r.next_action.includes('候选')));
});

test('closure B9 malformed injection gold is an input gap with a matching repair action',async t=>{
 const {main}=await import('./catalog-marks.ts');const f=privateInputs(t),gold=join(f.out,'../bad-gold.json'),screen:string[]=[];writeFileSync(gold,'{}');
 assert.equal(main([...cliArgs(f),'--gold',gold],l=>screen.push(l)),1);
 assert.ok(!screen.join('').includes('金标准缺陷'));
 const requests=JSON.parse(readFileSync(join(f.out,'evidence-requests.json'),'utf8'));assert.match(requests[0].fact,/gold.*结构/);assert.match(requests[0].next_action,/重新注入/);
});
test('closure B9 readable input inside a checkout requests relocation instead of reexport',async t=>{
 const {main}=await import('./catalog-marks.ts');const f=privateInputs(t),directory=mkdtempSync(join(tmpdir(),'gold-in-git-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));writeFileSync(join(directory,'.git'),'gitdir: synthetic');
 const gold=join(directory,'gold.json');writeFileSync(gold,'[]');assert.equal(main([...cliArgs(f),'--gold',gold],()=>{}),1);
 const requests=JSON.parse(readFileSync(join(f.out,'evidence-requests.json'),'utf8'));assert.match(requests[0].fact,/Git/);assert.match(requests[0].next_action,/移到 Git 外/);assert.ok(!requests[0].next_action.includes('编码'));
});
