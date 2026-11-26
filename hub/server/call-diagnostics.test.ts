import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argumentDigest, newId } from '../records/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { privateDiagnosticScope, rejectedDiagnostics } from './call-diagnostics.ts';

const hash = 'a'.repeat(64);
const user = 'usr_' + '0'.repeat(26);
const denied = { code: 'SOURCE_ABSENT', path: '/pack', message: '合成私有工作流', fix: '使用合成私有名称' };
const preview = (notes: string[]) => JSON.parse(notes.find(note => note.startsWith('参数预览 '))!.slice('参数预览 '.length));

test('the published field and its full path decide which argument values are visible', () => {
  const reference = 'src:' + hash;
  const args = {
    pack: 'synthetic@1.2.3', product: '合成产品', version: '2', build: 'build-1',
    inputs: { subject: [{ reference }, { external: 'doc:doc:synthetic' }] },
    parameters: { scope: ['first', 'second'], exclude: 3, enabled: true, title: '合成私文' },
    extra: { reference, product: 'synthetic', run: 'run_' + 'a'.repeat(26) },
  };
  const seen = preview(rejectedDiagnostics('start_run', args, [], false));
  assert.equal(seen.pack, args.pack);
  assert.equal(seen.product, args.product);
  assert.equal(seen.build, args.build);
  assert.equal(seen.version, args.version);
  assert.deepEqual(seen.inputs, args.inputs);
  assert.deepEqual(seen.parameters.scope, {type:'array', length:2, sha256:argumentDigest(args.parameters.scope).digest.slice(0,12)});
  assert.equal(seen.parameters.exclude.type, 'number');
  assert.equal(seen.parameters.enabled.type, 'boolean');
  assert.equal(seen.parameters.title.length, Buffer.byteLength(args.parameters.title));
  assert.ok(Object.values(seen.extra).every(value => typeof value === 'object'));
  assert.deepEqual(preview(rejectedDiagnostics('list_task_packs', {kind:'workflow', offset:3}, [], false)), {kind:'workflow', offset:3});
  assert.equal(preview(rejectedDiagnostics('list_task_packs', {kind:'arbitrary'}, [], false)).kind.type, 'string');
});

test('personal modes, implicit spaces, and original calls inside call_query disclose only structure and error location', async t => {
  const records = await openTestRecords();
  t.after(() => records.close());
  const deps = { records, workflows:{ summaries: async () => [] } };
  const member = { id:user, role:'user' as const, name:'合成成员' };
  for (const [tool, args] of [
    ['start_run', { pack: 'synthetic-private', pack_space: user }],
    ['upload_file', { personal_entry: { statement: 'private' } }],
    ['upload_file', { memory: { title: 'private' } }],
    ['get_nodes', { paths: ['/'], depth: 2 }],
    ['get_nodes', { search: 'private' }],
    ['get_nodes', { space:user }],
    ['get_nodes', { call_query: { start_run: { pack_space:user, pack:'synthetic-private' } } }],
    ['get_nodes', { call_query: { get_nodes: { memory: {} } } }],
  ] as const) {
    const personal = await privateDiagnosticScope(deps, member, tool, args);
    assert.equal(personal, true);
    const notes = rejectedDiagnostics(tool, args, [denied], personal);
    assert.doesNotMatch(notes.join('\n'), /synthetic-private|合成私有|["]private["]/);
    assert.deepEqual(JSON.parse(notes[1].slice('调用错误 '.length)), {code:denied.code, path:denied.path});
  }
  const source = await records.artifacts.ingest({
    bytes: Buffer.from('合成私有输入'), mediaType:'text/plain', name:'private.txt',
    author:{user}, origin:{upload:{session:null, message:null}}, provenanceType:'declared',
    visibility:{readers:[user], admins:false, packs:[], shareable:false},
  });
  const run = newId('run');
  const frozen = await records.store.put({kind:'run', schema:'run@1', provenance:'observed',
    body:{run, sources:[{artifact:source.digest}]}, index:[{key:'runs.id', value:run}]});
  for (const [tool, args] of [
    ['start_run', {pack:'synthetic',inputs:{subject:{reference:'src:'+source.body.sha256}}}],
    ['submit_result', {run}],
    ['list_task_packs', {booking:{run,workflow:'synthetic'}}],
    ['get_nodes', {call_query:{get_nodes:{reference:'rec:'+frozen.digest}}}],
  ] as const) assert.equal(await privateDiagnosticScope(deps, member, tool, args), true, tool);
  const notes = rejectedDiagnostics('submit_result', {run:'run_'+'a'.repeat(26)}, [denied], true);
  assert.equal(preview(notes).run.type, 'string');
  assert.ok(!notes.join('\n').includes(denied.message));
});

test('all logged errors keep only their code and supplied path, in order', () => {
  const credential = 'password=SyntheticToken93711';
  const errors = [denied, { ...denied, code:'SOURCE_UNAVAILABLE' }, { code:'SYNTHETIC', message:credential }];
  const notes = rejectedDiagnostics('start_run', {pack:'synthetic',product:credential}, errors, false);
  assert.ok(!notes.some(note => note.startsWith('参数预览 ')), 'a credential matching the visible fields discards the whole preview');
  assert.ok(!notes.join('\n').includes('SyntheticToken93711'));
  assert.deepEqual(notes.map(s => JSON.parse(s.slice('调用错误 '.length))), [{ code:denied.code, path:denied.path }, { code:'SOURCE_UNAVAILABLE', path:'/pack' }, { code:'SYNTHETIC' }]);
  const value = preview(rejectedDiagnostics('start_run', {parameters:{note:credential}}, [], false));
  assert.equal(value.parameters.note.type,'string');
});

test('a truncated preview is marked within the UTF-8 byte budget and never splits a field into a credential prefix', () => {
  const prefix = '短字段'.repeat(95);
  const args = { [prefix]:'v', product:'a'.repeat(700)+' password=SyntheticToken93711' };
  const notes = rejectedDiagnostics('start_run', args, [], false);
  const text = notes[0].slice('参数预览 '.length);
  assert.ok(Buffer.byteLength(text) <= 1024);
  assert.ok(text.endsWith('…（已截断）'));
  assert.ok(!text.includes('a'.repeat(100)));
  assert.ok(text.isWellFormed());
});
