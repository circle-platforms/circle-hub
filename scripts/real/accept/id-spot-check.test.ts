import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, sampleIds } from './id-spot-check.ts';

const data = { requirements: ['870001', '870002', '870001'], defects: ['880001'], unclassified: ['890001', '890002'] };
const raw = { partitions: { delivered: [{ item: '950801', requirements: [{ requirement: 'location', claims: [{ statement: { data } }] }] }] } };
function world(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'gold-location-spot-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const results = join(root, 'results'); mkdirSync(results); mkdirSync(join(results, 'runs'));
  writeFileSync(join(results, 'runs/000001.get_nodes.json'), JSON.stringify({ request: { tool: 'get_nodes', args: { reference: `rec:${'a'.repeat(64)}` } }, response: { isError: false, text: '', structured: { call_result: 'ok', content: { text: JSON.stringify(raw) } } } }), { mode: 0o600 });
  return { root, results, record: join(root, 'record.json') };
}
test('the same seed yields the same samples independent of source order; oversized count samples all', () => {
  const rows = [{ id: '870001', kind: 'story' as const, external: 'plm:story:870001', documents: ['950801'] }, { id: '880001', kind: 'bug' as const, external: 'plm:bug:880001', documents: ['950801'] }];
  assert.deepEqual(sampleIds(rows, 1, 'synthetic'), sampleIds([...rows].reverse(), 1, 'synthetic'));
  assert.equal(sampleIds(rows, 50, 'synthetic').length, 2);
});
test('samples all categories including unclassified IDs and writes a private immutable record', async t => {
  const w = world(t), screen: string[] = [];
  const argv = ['sample', '--results', w.results, '--count', '99', '--seed', 'synthetic', '--record', w.record];
  assert.equal(await main(argv, line => screen.push(line)), 0);
  const record = JSON.parse(readFileSync(w.record, 'utf8'));
  assert.equal(record.entries.length, 5); assert.ok(record.entries.every((r: { found: unknown }) => r.found === null));
  assert.ok(record.entries.some((r: { kind: unknown; id: string }) => r.kind === null && r.id === '890001'));
  assert.equal(statSync(w.record).mode & 0o777, 0o600);
  const previous = readFileSync(w.record, 'utf8');
  assert.equal(await main(argv, () => {}), 2); assert.equal(readFileSync(w.record, 'utf8'), previous);
  for (const id of ['870001', '870002', '880001', '890001', '950801']) assert.ok(!screen.join('').includes(id));
  assert.match(screen.join(''), /需求 2.*缺陷 1.*未分类 2/); assert.ok(screen.join('').includes('synthetic'));
});
test('record paths in Git are rejected', async t => {
  const w = world(t);
  assert.equal(await main(['sample', '--results', w.results, '--record', new URL('./forbidden-record.json', import.meta.url).pathname], () => {}), 2);
});
test('tally counts found, not found and blank exactly; only all found exits zero', async t => {
  const w = world(t); await main(['sample', '--results', w.results, '--count', '3', '--seed', 'synthetic', '--record', w.record], () => {});
  const record = JSON.parse(readFileSync(w.record, 'utf8')), screen: string[] = [];
  assert.equal(await main(['tally', '--record', w.record], s => screen.push(s)), 2);
  record.entries[0].found = true; record.entries[1].found = false;
  writeFileSync(w.record, JSON.stringify(record));
  assert.equal(await main(['tally', '--record', w.record], s => screen.push(s)), 1);
  assert.match(screen.join(''), /找到 1.*没找到 1.*没填 1/);
  record.entries.forEach((r: { found: boolean }) => { r.found = true; }); writeFileSync(w.record, JSON.stringify(record));
  assert.equal(await main(['tally', '--record', w.record], () => {}), 0);
  record.entries[0].found = 'yes'; writeFileSync(w.record, JSON.stringify(record));
  assert.equal(await main(['tally', '--record', w.record], () => {}), 2);
});
test('random seed is recorded and printed, while count and seed syntax are validated', async t => {
  const w = world(t), screen: string[] = [];
  assert.equal(await main(['sample', '--results', w.results, '--record', w.record], line => screen.push(line)), 0);
  const record = JSON.parse(readFileSync(w.record, 'utf8')); assert.match(record.seed, /^[a-f0-9]{32}$/); assert.ok(screen.join('').includes(record.seed));
  assert.equal(await main(['sample', '--results', w.results, '--count', '0', '--record', join(w.root, 'bad.json')], () => {}), 2);
  assert.equal(await main(['sample', '--results', w.results, '--seed', 'bad\nseed', '--record', join(w.root, 'bad.json')], () => {}), 2);
});

test('incomplete ID facts produce no sample and record the exact missing field and next action', async t => {
  const w = world(t);
  const file = join(w.results, 'runs/000001.get_nodes.json'), capture = JSON.parse(readFileSync(file, 'utf8'));
  const result = JSON.parse(capture.response.structured.content.text);
  delete result.partitions.delivered[0].requirements[0].claims[0].statement.data.unclassified;
  capture.response.structured.content.text = JSON.stringify(result); writeFileSync(file, JSON.stringify(capture));
  assert.equal(await main(['sample', '--results', w.results, '--record', w.record], () => {}), 2);
  const record = JSON.parse(readFileSync(w.record, 'utf8'));
  assert.equal(record.entries.length, 0);
  assert.equal(record.not_run[0].document, '950801'); assert.match(record.not_run[0].fact, /unclassified/); assert.ok(record.not_run[0].next_action);
  assert.equal(await main(['tally', '--record', w.record], () => {}), 2);
});
test('manual records cannot duplicate a sampled identity', async t => {
  const w = world(t); await main(['sample', '--results', w.results, '--count', '1', '--record', w.record], () => {});
  const record = JSON.parse(readFileSync(w.record, 'utf8')); record.entries[0].found = true; record.entries.push(record.entries[0]);
  writeFileSync(w.record, JSON.stringify(record));
  assert.equal(await main(['tally', '--record', w.record], () => {}), 2);
});

test('UTF-8 seed concatenated with identifier determines the hash order', () => {
  const rows = [{ id: '870001', kind: 'story' as const, external: 'plm:story:870001', documents: [] }, { id: '880001', kind: 'bug' as const, external: 'plm:bug:880001', documents: [] }];
  assert.equal(sampleIds(rows, 1, 'seed-a')[0].id, '880001');
  assert.equal(sampleIds(rows, 1, 'seed-b')[0].id, '870001');
});

test('a document requested but absent from result data is named before any sample is drawn', async t => {
  const w = world(t);
  writeFileSync(join(w.results, 'runs/000000.start_run.json'), JSON.stringify({ request: { tool: 'start_run', args: { inputs: { documents: [{ external: 'agile:mindmap:950801' }, { external: 'agile:mindmap:950802' }] } } }, response: { isError: false, text: '', structured: { call_result: 'ok' } } }));
  assert.equal(await main(['sample', '--results', w.results, '--record', w.record], () => {}), 2);
  const record = JSON.parse(readFileSync(w.record, 'utf8'));
  assert.equal(record.entries.length, 0);
  assert.ok(record.not_run.some((row: { document: string; next_action: string }) => row.document === '950802' && row.next_action.includes('重跑')));
});

test('location review 6: refused documents are excluded with codes while available results can be sampled', async t => {
  const w = world(t);
  writeFileSync(join(w.results, 'runs/000000.start_run.json'), JSON.stringify({ request: { tool: 'start_run', args: { inputs: { documents: [{ external: 'agile:mindmap:950801' }, { external: 'agile:mindmap:950802' }] } } }, response: { isError: false, text: '', structured: { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', path: '/inputs/documents/1' }] } } }));
  const screen: string[] = [];
  assert.equal(await main(['sample', '--results', w.results, '--record', w.record], l => screen.push(l)), 0);
  const record = JSON.parse(readFileSync(w.record, 'utf8')); assert.equal(record.entries.length, 5); assert.equal(record.excluded[0].document, '950802'); assert.match(record.excluded[0].reason, /SOURCE_UNAVAILABLE/);
  assert.ok(screen.some(l => l.includes('排除 1')));
});

test('closure unread accepted result pauses sampling and uses the saved get_nodes reference', async t => {
 const w=world(t), reference='rec:'+'b'.repeat(64);
 writeFileSync(join(w.results,'runs/000002.start_run.json'),JSON.stringify({request:{tool:'start_run',args:{inputs:{documents:[{external:'agile:mindmap:950802'}]}}},response:{isError:false,text:'',structured:{call_result:'ok',result:{reference}}}}));
 writeFileSync(join(w.results,'runs/000003.get_nodes.json'),JSON.stringify({transport_error:true,request:{tool:'get_nodes',args:{reference}},response:{isError:true,text:'',structured:{call_result:'error',errors:[]}}}));
 assert.equal(await main(['sample','--results',w.results,'--record',w.record],()=>{}),2);
 const record=JSON.parse(readFileSync(w.record,'utf8'));assert.equal(record.entries.length,0);
 assert.ok(record.not_run.some((r:any)=>r.document==='950802' && r.next_action.includes('location-tree.ts') && r.next_action.includes('--collect') && r.recovery.args.reference===reference));
});

test('closure a timed out retry supersedes the earlier batch refusal and pauses sampling', async t => {
 const w=world(t);
 const first={request:{tool:'start_run',args:{inputs:{documents:[{external:'agile:mindmap:950802'},{external:'agile:mindmap:950803'}]}}},response:{isError:false,text:'',structured:{call_result:'error',errors:[{code:'SOURCE_UNAVAILABLE',path:'/inputs/documents/1'}]}}};
 const retry={session:'synthetic',transport_error:true,request:{tool:'start_run',args:{client_key:'synthetic-stable-key',inputs:{documents:[{external:'agile:mindmap:950802'}]}}},response:{isError:true,text:'',structured:{call_result:'error',errors:[]}}};
 writeFileSync(join(w.results,'runs/000002.start_run.json'),JSON.stringify(first));writeFileSync(join(w.results,'runs/000003.start_run.json'),JSON.stringify(retry));
 assert.equal(await main(['sample','--results',w.results,'--record',w.record],()=>{}),2);
 const record=JSON.parse(readFileSync(w.record,'utf8'));assert.equal(record.population_complete,false);assert.equal(record.entries.length,0);
 assert.deepEqual(record.excluded.map((r:any)=>r.document),['950803']);
 assert.ok(record.not_run.some((r:any)=>r.document==='950802' && r.next_action.includes('同一 client_key') && r.next_action.includes('--collect') && r.recovery.args.client_key==='synthetic-stable-key'));
});

test('closure B5 accepted without a reference blocks sampling and names the Hub persistence gap',async t=>{
 const w=world(t);rmSync(join(w.results,'runs/000001.get_nodes.json'));const args={client_key:'synthetic-key-without-result',inputs:{documents:[{external:'agile:mindmap:950802'}]}};
 writeFileSync(join(w.results,'runs/000002.start_run.json'),JSON.stringify({session:'synthetic',request:{tool:'start_run',args},response:{isError:false,text:'运行 rn_without_result：任务包 case-location\n问题：定位合成文档',structured:{call_result:'ok',errors:[],run:{run:'rn_without_result',pack:'case-location@1.0.0',items:[],requirements:[]}}}}));
 assert.equal(await main(['sample','--results',w.results,'--record',w.record],()=>{}),2);
 const record=JSON.parse(readFileSync(w.record,'utf8'));assert.equal(record.population_complete,false);assert.equal(record.entries.length,0);
 const pending=record.not_run.find((row:any)=>row.document==='950802');assert.match(pending.fact,/已受理.*没有结果引用/);assert.deepEqual(pending.recovery.args,args);assert.equal(pending.recovery.run,'rn_without_result');assert.match(pending.next_action,/不会补生成结果/);
 assert.ok(record.not_run.every((row:any)=>!row.next_action.includes('重跑全树采集')));
});
