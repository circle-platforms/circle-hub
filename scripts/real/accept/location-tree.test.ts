import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareLocationTree, main, type Capture } from './location-tree.ts';
import { locationsGold } from '../gold/locations.ts';
import type { ToolText } from '../hub-call.ts';

const tree = (count = 1): unknown => ({ root: { id: 'synthetic-root', label: '合成产品' }, children: [{ id: 'line', label: '181：10.8.1', children: [{ id: 'train', label: '182：10.8.1-R9', children: [{ id: 'module', label: '183：合成模块甲', children: Array.from({ length: count }, (_, i) => ({ id: String(940801 + i), label: '合成文档', children: [] })) }] }] }] });
const data = (fields = {}): Record<string, unknown> => ({ case_id: '940801', version: '10.8.1', line: '10.8.1', train: '10.8.1-R9', module: '合成模块甲', requirements: ['840001'], defects: ['850001'], unclassified: ['860001'], ...fields });
const result = (documents = ['940801'], fields = {}): { partitions: { delivered: { item: string; requirements: { requirement: string; claims: { statement: { data: Record<string, unknown> } }[] }[] }[] } } => ({ partitions: { delivered: documents.map(document => ({ item: document, requirements: [{ requirement: 'location', claims: [{ statement: { data: data({ ...fields, case_id: document }) } }] }, { requirement: 'build_candidates', claims: [{ statement: { data: { candidates: [] } } }] }] })) } });
const captures = (raw: unknown): Capture[] => [{ request: { tool: 'get_nodes', args: { reference: `rec:${'a'.repeat(64)}` } }, response: { isError: false, text: '', structured: { call_result: 'ok', content: { text: JSON.stringify(raw) } } } }];
const emptyBuilds = [{ line: '10.8.1', candidates: [] }];

test('compares location statements in any partition and reports absent build input as not run', () => {
  const equal = compareLocationTree(tree(), captures(result()), emptyBuilds);
  assert.equal(equal.summary.equal, 1); assert.equal(equal.summary.not_equal, 0); assert.equal(equal.summary.candidates.not_run, 0);
  const missing = compareLocationTree(tree(), captures(result()));
  assert.equal(missing.summary.candidates.not_run, 1);
  assert.ok(missing.details.not_run.every(row => row.next_action && row.fact));
});
for (const field of ['line', 'train', 'module']) test(`detects ${field} mismatch`, () => {
  const report = compareLocationTree(tree(), captures(result(['940801'], { [field]: '不同的合成值' })), emptyBuilds);
  assert.equal(report.summary.not_equal, 1);
  assert.equal(report.summary.fields[field as 'line' | 'train' | 'module'], 1);
});
test('10.6 and 10.6.0 are equal; normalization preserves null versus asserted values', () => {
  const input = JSON.parse(JSON.stringify(tree()).replaceAll('10.8.1', '10.6'));
  const report = compareLocationTree(input, captures(result(['940801'], { version: '10.6.0', line: '10.6.0', train: '10.6-R9', module: '　合成模块甲　' })), [{ line: '10.6', candidates: [] }]);
  assert.equal(report.summary.equal, 1);
  assert.equal(compareLocationTree(tree(), captures(result(['940801'], { module: null })), emptyBuilds).summary.not_equal, 1);
});
test('counts missing items, missing location data and extra items separately', () => {
  assert.equal(compareLocationTree(tree(), captures(result([])), emptyBuilds).summary.missing.no_item, 1);
  const noData = { partitions: { unknown: [{ item: '940801', requirements: [] }] } };
  assert.equal(compareLocationTree(tree(), captures(noData), emptyBuilds).summary.missing.no_location_data, 1);
  assert.equal(compareLocationTree(tree(), captures(result(['940801', '940899'])), emptyBuilds).summary.only_result, 1);
});
test('facets report missing documents and use document-bound production reasons only', () => {
  const facets = { rows: [], truncated: true, skipped: 3 };
  const production = [{ body: { detail: { lists: [{ skipped: [{ external: 'agile:mindmap:940801', reason: '读取档位是只保留，含凭据' }] }] } } }];
  const report = compareLocationTree(tree(), captures(result()), emptyBuilds, facets, production);
  assert.equal(report.summary.facets!.only_tree, 1);
  assert.equal(report.summary.facets!.truncated, true); assert.equal(report.summary.facets!.skipped, 3);
  assert.equal(report.summary.facets!.reasons.retain_only, 1);
  const unknown = compareLocationTree(tree(), captures(result()), emptyBuilds, facets);
  assert.equal(unknown.summary.facets!.reasons.unknown, 1);
  assert.ok(unknown.details.facet_missing[0].next_action);
});
test('compares all structured candidates including beyond the display limit', () => {
  const gold = Array.from({ length: 15 }, (_, i) => ({ name: `Rel_FAMX_10_8_1_${i}`, family: 'FAMX', base: `Rel_FAMX_10_8_1_${i}`, built: null, released: null }));
  const raw = result(); const req = raw.partitions.delivered[0].requirements[1];
  req.claims[0].statement.data = { candidates: gold.map(c => ({ name: c.name, family: c.family, base: c.base, alias: false, built_at: null, released: false })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
  const correct = compareLocationTree(tree(), captures(raw), [{ line: '10.8.1', candidates: gold }]);
  assert.equal(correct.summary.candidates.equal, 1);
  ((req.claims[0].statement.data.candidates as { family: string }[])[14]).family = 'FAMY';
  assert.equal(compareLocationTree(tree(), captures(raw), [{ line: '10.8.1', candidates: gold }]).summary.candidates.not_equal, 1);
});
test('collect batches five documents as 2,2,1, reopens the rest once after path refusals, and replays without network', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gold-location-tree-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const treeFile = join(root, 'tree.json'), token = join(root, 'token'), buildFile = join(root, 'builds.json'), out = join(root, 'out');
  writeFileSync(treeFile, JSON.stringify(tree(5))); writeFileSync(token, 'synthetic-token'); writeFileSync(buildFile, JSON.stringify(emptyBuilds[0]));
  const started: string[][] = []; const forRef = new Map<string, string[]>(); let refused = false;
  const fake = async (_options: unknown, calls: { tool: string; args: unknown }[]): Promise<ToolText[]> => calls.map(call => {
    const args = call.args as { inputs?: { documents: { external: string }[] }; reference?: string };
    if (call.tool === 'start_run') {
      const docs = args.inputs!.documents.map(d => d.external.split(':').at(-1)!); started.push(docs);
      if (!refused) { refused = true; return { isError: false, text: '', structured: { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', path: '/inputs/documents/0' }] } }; }
      const reference = `rec:${String(started.length).padStart(64, '0')}`; forRef.set(reference, docs);
      return { isError: false, text: '', structured: { call_result: 'ok', result: { reference } } };
    }
    return { isError: false, text: '', structured: { call_result: 'ok', content: { text: JSON.stringify(result(forRef.get(args.reference!)!)) } } };
  });
  const screen: string[] = [];
  const argv = ['--tree', treeFile, '--builds', buildFile, '--out', out, '--collect', '--token-file', token, '--batch', '2'];
  assert.equal(await main(argv, { call: fake, print: s => screen.push(s) }), 1);
  assert.deepEqual(started.map(d => d.length), [2, 1, 2, 1]);
  const details = JSON.parse(readFileSync(join(out, 'details.json'), 'utf8'));
  assert.equal(details.summary.missing.start_refused, 1);
  assert.equal(statSync(join(out, 'details.json')).mode & 0o777, 0o600);
  assert.equal(await main(argv, { call: async () => { throw new Error('must not call'); }, print: () => {} }), 2);
  assert.equal(await main(['--tree', treeFile, '--builds', buildFile, '--out', out], { call: async () => { throw new Error('offline'); }, print: () => {} }), 1);
  for (const forbidden of ['940801', '940802', '10.8.1', '合成模块甲', 'synthetic-token']) assert.ok(!screen.join('').includes(forbidden));
});
test('source never imports hub or packs', () => {
  const source = readFileSync(new URL('./location-tree.ts', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(?:hub\/|packs\/)/.test(source));
});


test('missing Hub candidate fields are mismatches and identify a reread action', () => {
  const raw = result();
  raw.partitions.delivered[0].requirements[1].claims[0].statement.data = { candidates: [{ name: 'Rel_FAMX_10_8_1_41' }] };
  const report = compareLocationTree(tree(), captures(raw), [{ line: '10.8.1', candidates: [{ name: 'Rel_FAMX_10_8_1_41', family: 'FAMX', base: 'Rel_FAMX_10_8_1_41', built: null, released: null }] }]);
  assert.equal(report.summary.candidates.not_run, 0);
  assert.equal(report.summary.candidates.not_equal, 1);
  assert.ok(report.details.candidates.some(row => row.reason.includes('缺候选字段') && row.next_action));
});
test('facet missing reasons do not borrow aggregate counts or reasons of another document', () => {
  const facets = { rows: [{ values: { document: '940899' }, count: 1 }], truncated: false, skipped: 0 };
  for (const [reason, field] of [['没有用例节点', 'no_cases'], ['不是 KityMinder 脑图', 'not_mindmap']] as const) {
    const report = compareLocationTree(tree(), captures(result()), emptyBuilds, facets, [{ skipped: [{ external: 'agile:mindmap:940801', reason }] }]);
    assert.equal(report.summary.facets!.reasons[field], 1);
    assert.equal(report.summary.facets!.only_view, 1);
  }
  const unrelated = compareLocationTree(tree(), captures(result()), emptyBuilds, facets, [{ skipped: [{ external: 'agile:mindmap:940899', reason: '没有用例节点' }], warnings: ['1 份文档里没有用例节点'] }]);
  assert.equal(unrelated.summary.facets!.reasons.unknown, 1);
});
test('a whole-batch refusal without input paths does not reopen other documents', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gold-location-refused-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tree.json'), JSON.stringify(tree(2))); writeFileSync(join(root, 'token'), 'synthetic-token');
  let calls = 0;
  const code = await main(['--tree', join(root, 'tree.json'), '--out', join(root, 'out'), '--collect', '--token-file', join(root, 'token')], { call: async () => { calls++; return [{ isError: false, text: '', structured: { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE' }] } }]; }, print: () => {} });
  assert.equal(code, 1); assert.equal(calls, 1);
});

test('unknown facet reasons identify the document, missing record and a private fetch command', () => {
  const reference = `rec:${'c'.repeat(64)}`;
  const records = [{ digest: 'c'.repeat(64), body: { detail: { lists: [{ skipped: [{ external: 'agile:mindmap:940801', reason: '合成原因尚未分类' }] }] } } }];
  const report = compareLocationTree(tree(), captures(result()), emptyBuilds, { rows: [] }, records);
  const missing = report.details.facet_missing[0];
  assert.equal(missing.document, '940801');
  assert.ok(missing.fact.includes('生产记录'));
  assert.equal(missing.production_reference, reference);
  assert.ok(missing.next_command.includes('BEGIN READ ONLY'));
  assert.ok(missing.next_command.includes('body::jsonb'));
  assert.ok(missing.next_command.includes(reference.slice(4)));
  const absent = compareLocationTree(tree(), captures(result()), emptyBuilds, { rows: [] }).details.facet_missing[0];
  assert.equal(absent.production_reference, null);
  assert.match(absent.next_action, /询问集成者/);
});

test('production input accepts database record arrays and documents the required JSON shape', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gold-location-production-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const treeFile = join(root, 'tree.json'), token = join(root, 'token'), production = join(root, 'production.json'), out = join(root, 'out');
  writeFileSync(treeFile, JSON.stringify(tree())); writeFileSync(token, 'synthetic-token');
  writeFileSync(production, JSON.stringify([{ digest: 'c'.repeat(64), kind: 'action', schema: 'action@1', body: { action: 'generate', detail: { root: 'a'.repeat(64), lists: [] } } }]));
  const screen: string[] = []; await main(['--help'], { print: line => screen.push(line) });
  assert.ok(screen.join('').includes('body::jsonb')); assert.ok(screen.join('').includes('digest'));
  const fake = async (_options: unknown, calls: { tool: string; args: unknown }[]): Promise<ToolText[]> => calls.map(call => call.tool === 'start_run' ? { isError: false, text: '', structured: { call_result: 'ok', result: { reference: `rec:${'a'.repeat(64)}` } } } : { isError: false, text: '', structured: { call_result: 'ok', content: { text: JSON.stringify(result()) } } });
  assert.equal(await main(['--tree', treeFile, '--out', out, '--production', production, '--collect', '--token-file', token], { call: fake, print: () => {} }), 2);
  assert.equal(JSON.parse(readFileSync(join(out, 'details.json'), 'utf8')).input_sha256.production.length, 1);
});

test('classifies only reproducible prefix and version-node differences', () => {
  const prefix = compareLocationTree(tree(), captures(result(['940801'], { module: '183：合成模块甲' })), emptyBuilds);
  assert.equal(prefix.summary.reasons.prefix_codes, 1);
  const fabricated = compareLocationTree(tree(), captures(result(['940801'], { version: '10.9.1', line: '10.9.1', version_source: 'folders', ancestor_path: ['181：10.8.1', '184：10.9.1'] })), emptyBuilds);
  assert.equal(fabricated.summary.reasons.version_nodes, 0, 'the checked output cannot invent an ancestor');
  const nested = { root: { id: 'root', label: '合成产品' }, children: [{ id: 'first', label: '181：10.8.1', children: [{ id: 'last', label: '184：10.9.1', children: [{ id: '940801', label: '合成文档', children: [] }] }] }] };
  const expected = locationsGold(nested).all![0];
  const selected = compareLocationTree(nested, captures(result(['940801'], { version: '10.8.1', line: '10.8.1', train: expected.train, module: expected.module, version_source: 'folders' })), [{ line: expected.line!, candidates: [] }]);
  assert.equal(selected.summary.reasons.version_nodes, 1);
});
test('production records of another facet root do not explain this root', () => {
  const report = compareLocationTree(tree(), captures(result()), emptyBuilds, { build: { root: 'a'.repeat(64) }, rows: [] }, [{ body: { detail: { root: 'b'.repeat(64), lists: [{ skipped: [{ external: 'agile:mindmap:940801', reason: '没有用例节点' }] }] } } }]);
  assert.equal(report.summary.facets!.reasons.unknown, 1);
});

test('unavailable facet explanations are not-run rather than an overall verified pass', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gold-location-facet-pending-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tree.json'), JSON.stringify(tree())); writeFileSync(join(root, 'token'), 'synthetic-token');
  writeFileSync(join(root, 'builds.json'), JSON.stringify(emptyBuilds[0]));
  writeFileSync(join(root, 'facets.json'), JSON.stringify({ rows: [], truncated: false, skipped: 0 }));
  const fake = async (_options: unknown, calls: { tool: string; args: unknown }[]): Promise<ToolText[]> => calls.map(call => call.tool === 'start_run' ? { isError: false, text: '', structured: { call_result: 'ok', result: { reference: `rec:${'a'.repeat(64)}` } } } : { isError: false, text: '', structured: { call_result: 'ok', content: { text: JSON.stringify(result()) } } });
  const screen: string[] = [];
  assert.equal(await main(['--tree', join(root, 'tree.json'), '--builds', join(root, 'builds.json'), '--facets', join(root, 'facets.json'), '--out', join(root, 'out'), '--collect', '--token-file', join(root, 'token')], { call: fake, print: line => screen.push(line) }), 2);
  assert.match(screen.join(''), /判定：没跑完/);
  const details = JSON.parse(readFileSync(join(root, 'out/details.json'), 'utf8'));
  assert.ok(details.details.not_run.some((row: { document: string; next_command: string }) => row.document === '940801' && row.next_command.includes('READ ONLY')));
});

test('location review 2: Hub ISO Z and milliseconds compare at source precision without hiding a different second', () => {
  const gold = { line: '10.8.1', candidates: [{ name: 'Rel_FAMX_10_8_1_41', family: 'FAMX', base: 'Rel_FAMX_10_8_1_41', built: '2026-08-20T12:30:40', released: null }] };
  for (const built_at of ['2026-08-20T12:30:40Z', '2026-08-20T12:30:40.000Z']) {
    const raw = result(); raw.partitions.delivered[0].requirements[1].claims[0].statement.data = { candidates: [{ name: gold.candidates[0].name, family: 'FAMX', base: gold.candidates[0].base, alias: false, built_at, released: false }] };
    assert.equal(compareLocationTree(tree(), captures(raw), [gold]).summary.candidates.equal, 1);
    (raw.partitions.delivered[0].requirements[1].claims[0].statement.data.candidates as { built_at: string }[])[0].built_at = '2026-08-20T12:30:41Z';
    assert.equal(compareLocationTree(tree(), captures(raw), [gold]).summary.candidates.not_equal, 1);
  }
});

test('location review 4: empty or wrong-shaped trees never start calls or pass vacuously', async t => {
  const root = mkdtempSync(join(tmpdir(), 'location-empty-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'token'), 'synthetic-token');
  for (const [i, value] of [{}, ['not','a','tree'], { root: { id: 'empty' } }].entries()) {
    const file = join(root, `tree${i}.json`); writeFileSync(file, JSON.stringify(value)); let calls = 0; const screen: string[] = [];
    assert.equal(await main(['--tree', file, '--out', join(root, `out${i}`), '--collect', '--token-file', join(root, 'token')], { call: async () => { calls++; return []; }, print: s => screen.push(s) }), 2);
    assert.equal(calls, 0); assert.ok(screen.some(s => s.includes('--tree') && s.includes('重新导出')));
  }
});

test('location review 5: a title version is not a folder version line', () => {
  const rawTree = { root: { id: 'root', label: '合成产品' }, children: [{ id: '940801', label: '合成 10.8.2.31 升级', children: [] }] };
  const raw = result(['940801'], { version: '10.8.2.31', line: null, train: null, module: null, version_source: 'title' });
  assert.equal(compareLocationTree(rawTree, captures(raw)).summary.not_equal, 0);
});

test('location review 7: missing Hub candidate output is wrong rather than missing gold input', () => {
  const raw = result(); raw.partitions.delivered[0].requirements = raw.partitions.delivered[0].requirements.slice(0, 1);
  const report = compareLocationTree(tree(), captures(raw), emptyBuilds);
  assert.equal(report.summary.candidates.not_equal, 1); assert.equal(report.summary.candidates.not_run, 0);
  assert.ok(report.details.candidates.some(row => row.reason.includes('缺候选') && row.next_action));
});

test('location review 8: version node differences are classified from the original path with documented sources', () => {
  const nested = { root: { id: 'r', label: '合成产品' }, children: [{ id: 'first', label: '181：10.8.1', children: [{ id: 'last', label: '184：10.9.1', children: [{ id: '940801', label: '合成文档', children: [] }] }] }] };
  const report = compareLocationTree(nested, captures(result(['940801'], { version: '10.8.1', line: '10.8.1', train: null, module: null, version_source: 'folders' })), [{ line: '10.9.1', candidates: [] }]);
  assert.equal(report.summary.reasons.version_nodes, 1);
});

test('location review 9: transport loss preserves a client key and never claims the start was refused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'location-timeout-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tree.json'), JSON.stringify(tree())); writeFileSync(join(root, 'token'), 'synthetic-token');
  const requests: unknown[] = [], screen: string[] = [];
  const code = await main(['--tree', join(root, 'tree.json'), '--out', join(root, 'out'), '--collect', '--token-file', join(root, 'token')], { call: async (_options, calls) => { requests.push(calls[0].args); throw new Error('synthetic timeout'); }, print: line => screen.push(line) });
  assert.equal(code, 2);
  const details = JSON.parse(readFileSync(join(root, 'out/details.json'), 'utf8'));
  assert.equal(details.summary.missing.start_refused, 0); assert.equal(details.summary.missing.start_uncertain, 1);
  assert.ok(typeof (requests[0] as { client_key: unknown }).client_key === 'string');
  const pending = details.details.not_run[0]; assert.ok(pending.next_action.includes('同一 client_key')); assert.deepEqual(pending.recovery.args, requests[0]);
  assert.ok(!screen.join('').includes((requests[0] as { client_key: string }).client_key));
});

test('closure null line is a definite empty candidate answer and can pass the full tree CLI', async t => {
 const input={root:{id:'r',label:'合成产品'},children:[{id:'generic',label:'通用用例',children:[{id:'940801',label:'合成文档',children:[]}]}]};
 const raw=result(['940801'],{version:null,line:null,train:null,module:null});
 const report=compareLocationTree(input,captures(raw));
 assert.equal(report.summary.candidates.equal,1);assert.equal(report.summary.candidates.not_run,0);
 const bad=structuredClone(raw);bad.partitions.delivered[0].requirements[1].claims[0].statement.data={candidates:[{}]};
 assert.ok(compareLocationTree(input,captures(bad)).details.candidates.some(d=>d.reason==='目录没有版本线却给出候选'));
 const root=mkdtempSync(join(tmpdir(),'null-line-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'out/runs'),{recursive:true});
 writeFileSync(join(root,'tree.json'),JSON.stringify(input));writeFileSync(join(root,'out/runs/000001.json'),JSON.stringify(captures(raw)[0]));
 const screen:string[]=[];assert.equal(await main(['--tree',join(root,'tree.json'),'--out',join(root,'out')],{print:l=>screen.push(l)}),0);assert.ok(screen.includes('判定：通过'));
});

test('closure collect recovery into a fresh output reuses the same original batch client key', async t => {
 const root=mkdtempSync(join(tmpdir(),'collect-key-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const treeFile=join(root,'tree.json'), token=join(root,'token'), builds=join(root,'builds.json');writeFileSync(treeFile,JSON.stringify(tree()));writeFileSync(token,'synthetic');writeFileSync(builds,JSON.stringify(emptyBuilds[0]));
 const keys:string[]=[];const created=new Set<string>();let timedOut=false;
 const fake=async (_options:unknown,calls:{tool:string;args:unknown}[]):Promise<ToolText[]>=>{
  const call=calls[0];if(call.tool==='start_run'){const key=(call.args as {client_key:string}).client_key;keys.push(key);created.add(key);if(!timedOut){timedOut=true;throw new Error('synthetic lost receipt');}return[{isError:false,text:'',structured:{call_result:'ok',result:{reference:'rec:'+'f'.repeat(64)}}}];}
  return[{isError:false,text:'',structured:{call_result:'ok',content:{text:JSON.stringify(result())}}}];
 };
 const args=(out:string)=>['--tree',treeFile,'--builds',builds,'--out',out,'--collect','--token-file',token];
 assert.equal(await main(args(join(root,'first')),{call:fake,print:()=>{}}),2);
 assert.equal(await main(args(join(root,'second')),{call:fake,print:()=>{}}),0);
 assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(created.size,1);
});

test('closure unread result after an accepted start is transient and only asks to reread its saved reference', async t => {
 const root=mkdtempSync(join(tmpdir(),'result-read-'));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'tree.json'),JSON.stringify(tree()));writeFileSync(join(root,'token'),'synthetic');writeFileSync(join(root,'builds.json'),JSON.stringify(emptyBuilds[0]));
 const reference='rec:'+'e'.repeat(64);
 const code=await main(['--tree',join(root,'tree.json'),'--builds',join(root,'builds.json'),'--out',join(root,'out'),'--collect','--token-file',join(root,'token')],{call:async(_options,calls)=>{if(calls[0].tool==='start_run')return[{isError:false,text:'',structured:{call_result:'ok',result:{reference}}}];throw new Error('synthetic read timeout');},print:()=>{}});
 assert.equal(code,2);const report=JSON.parse(readFileSync(join(root,'out/details.json'),'utf8'));
 assert.equal(report.summary.missing.no_item,0);assert.equal(report.summary.missing.result_unread,1);
 assert.ok(report.details.not_run.some((r:any)=>r.next_action.includes('location-tree.ts') && r.next_action.includes('--collect') && r.next_action.includes('--batch') && r.recovery.args.reference===reference));
});

test('closure B4 unread results recover through a fresh same key collect without creating another run',async t=>{
 const root=mkdtempSync(join(tmpdir(),'unread-recollect-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const treeFile=join(root,'tree.json'),token=join(root,'token'),builds=join(root,'builds.json');writeFileSync(treeFile,JSON.stringify(tree()));writeFileSync(token,'synthetic');writeFileSync(builds,JSON.stringify(emptyBuilds[0]));
 const created=new Set<string>(),keys:string[]=[];let firstRead=true;
 const fake=async(_options:unknown,calls:{tool:string;args:unknown}[]):Promise<ToolText[]>=>{
  const call=calls[0];if(call.tool==='start_run'){const key=(call.args as {client_key:string}).client_key;keys.push(key);created.add(key);return[{isError:false,text:'运行已开始\n问题：定位合成文档',structured:{call_result:'ok',errors:[],run:{run:'run_synthetic',pack:'case-location@1.0.0',items:[],requirements:[]},result:{reference:'rec:'+'f'.repeat(64)}}}];}
  if(firstRead){firstRead=false;throw new Error('synthetic read timeout');}
  return[{isError:false,text:'条目 合成文档\n定位：已找到',structured:{call_result:'ok',content:{text:JSON.stringify(result())}}}];
 };
 const args=(out:string)=>['--tree',treeFile,'--builds',builds,'--out',out,'--collect','--token-file',token,'--batch','1'];
 assert.equal(await main(args(join(root,'first')),{call:fake,print:()=>{}}),2);
 const pending=JSON.parse(readFileSync(join(root,'first/details.json'),'utf8')).details.not_run[0];assert.match(pending.next_action,/location-tree.ts.*--collect/);assert.match(pending.next_action,/24/);assert.ok(pending.recovery.start_args.client_key);
 const screen:string[]=[];assert.equal(await main(args(join(root,'second')),{call:fake,print:l=>screen.push(l)}),0);assert.ok(screen.includes('判定：通过'));assert.equal(created.size,1);assert.equal(keys[0],keys[1]);
});

test('closure B5 an accepted run without a result reference is a Hub persistence gap',async t=>{
 const root=mkdtempSync(join(tmpdir(),'no-result-reference-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'tree.json'),JSON.stringify(tree()));writeFileSync(join(root,'builds.json'),JSON.stringify(emptyBuilds[0]));writeFileSync(join(root,'token'),'synthetic');
 const tools:string[]=[],screen:string[]=[];
 const code=await main(['--tree',join(root,'tree.json'),'--builds',join(root,'builds.json'),'--out',join(root,'out'),'--collect','--token-file',join(root,'token')],{call:async(_options,calls)=>{tools.push(calls[0].tool);return[{isError:false,text:'运行 rn_synthetic：任务包 case-location，条目 1 个\n问题：合成文档的定位',structured:{call_result:'ok',errors:[],run:{run:'rn_synthetic',pack:'case-location@1.0.0',items:[],requirements:[]}}}];},print:l=>screen.push(l)});
 assert.equal(code,2);assert.deepEqual(tools,['start_run']);const report=JSON.parse(readFileSync(join(root,'out/details.json'),'utf8'));
 assert.equal(report.summary.missing.no_item,0);assert.equal(report.summary.missing.result_unread,1);assert.equal(report.summary.candidates.not_run,1);
 const pending=report.details.not_run[0];assert.match(pending.fact,/已受理.*没有结果引用/);assert.equal(pending.recovery.run,'rn_synthetic');assert.ok(pending.recovery.args.client_key);assert.match(pending.next_action,/集成者.*Hub/);assert.match(pending.next_action,/不会补生成结果/);assert.ok(!screen.join('').includes('rn_synthetic'));assert.ok(!screen.includes('判定：不通过'));
});
