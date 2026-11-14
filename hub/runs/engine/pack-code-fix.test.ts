import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { fixOf } from './errors.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

const registeredFix = '补齐合成步骤后按原字节重交';
const core = 'core.catalog.param_out_of_range';

test('scripted model submissions return frozen package fixes, preserve core fixes and fall back only for unregistered codes', { skip: await sandboxSkip() }, async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const h = await openHarness(postgres); t.after(() => h.close());
  const spec = reviewPack(); spec.version = '1.0.1';
  spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: h.review.requirements.map(row => row.key === 'structure' ? {
    ...row, checks: ['pack_probe'], error_handling: [{ code: '*', action: 'repair', max_rounds: 2 }],
  } : row) } };
  spec.files['checks.json'] = { json: { schema: 'checks@1', checks: [
    ...h.review.checks.filter(row => row.id !== 'structure'),
    { id: 'pack_probe', function: { module: 'functions/pack-probe.ts' }, applies: 'item', judges: 'artifact_under_verification', tier: 'blocking', basis: '合成包码出口核对' },
  ] } };
  spec.files['tables/codes.json'] = { json: { schema: 'toy-review.codes@1', violations: [
    { code: 'toy-review.registered_fix', when: '合成已登记码', fix: registeredFix },
    { code: core, when: '不能覆盖核心码', fix: '不应返回这条包内覆盖' },
  ] } };
  spec.files['functions/pack-probe.ts'] = `export default input => ['toy-review.registered_fix','toy-review.unregistered_fix'].map(code => ({item:input.subject.id,verdict:'refute',code,statement:'合成脚本模型产物待改正',grounds:[],tier:'blocking'}));`;
  const workflow = await h.workflows.add(await writePack(dirname(h.review.pack.directory), spec));
  const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
  const source = await h.upload(h.alice, toyMap(document));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: source } } }, h.call());
  assert.ok(started.run, JSON.stringify(started.errors));
  const answer = await h.service.submitResult(h.alice, {
    run: started.run.run, model: 'synthetic-scripted-model',
    items: started.run.items.map(item => ({ item: item.id, handling: 'handled', slots: { findings: [{ text: '合成发现', code: 'literal_issue', rank: 'minor', location: item.location, quotes: [{ reference: item.location, text: item.label }] }] } })),
    cross_item: [{ nature: 'judgment', statement: '合成等级', grounds: [], code: 'draft_level', rank: 'P4' }],
  }, h.call());
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  assert.ok(answer.errors.some(row => row.code === 'toy-review.registered_fix'), JSON.stringify(answer.errors));
  assert.equal(answer.errors.find(row => row.code === 'toy-review.registered_fix')?.fix, registeredFix);
  assert.equal(answer.errors.find(row => row.code === 'toy-review.unregistered_fix')?.fix, '按陈述改正后重交');
  assert.equal(fixOf(core, workflow), CORE_VIOLATION_CODES[core].fix);
  assert.equal(fixOf('toy-review.registered_fix', workflow), registeredFix);
  t.mock.method(workflow, 'readJson', () => { throw new Error('synthetic code table unavailable'); });
  assert.equal(fixOf(core, workflow), CORE_VIOLATION_CODES[core].fix);
  assert.equal(fixOf('SOURCE_ABSENT', workflow), PROTOCOL_CODES.SOURCE_ABSENT.fix);
  assert.throws(() => fixOf('toy-review.registered_fix', workflow), /synthetic code table unavailable/);
});
