// A workflow bound to no product line (W03 R[5]: none named, no catalog required) runs for one build only when the caller
// names product and build together: the run then locks that build's root (W03 R[0], a declared build), so its reads can feed
// that product's layer. A product alone, a build alone or a product the caller cannot read stays refused, as before.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const UNBOUND: PackSpec = { id: 'synthetic-unbound', version: '1.0.0', kind: 'workflow', title: 'Synthetic unbound read', description: 'Synthetic read bound to no product line', files: {
  'workflow.json': { json: { schema: 'workflow@1', inputs: [{ slot: 'subject', role: 'subject', description: 'synthetic JSON', accepts: ['application/json'], required: true, many: false }], parameters: [], product: { catalogs: [] }, subject: 'subject', projection: { module: 'functions/project.ts' } } },
  'requirements.json': { json: { schema: 'requirements@1', requirements: [{ key: 'probe', name: 'Synthetic probe', description: 'Echo the target', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['probe'], error_handling: [] }] } },
  'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'probe', applies: 'run', judges: 'subject', reads: { roles: ['subject'] }, tier: 'advisory', function: { module: 'functions/check.ts' }, subject: { module: 'functions/subject.ts' } }] } },
  'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
  'SKILL.md': 'Read one synthetic source',
  'functions/project.ts': `export default input=>({items:[{id:'one',label:'Synthetic',location:{slot:'subject',parser:'json@1',selector:'p'},fields:{}}],warnings:[]});`,
  'functions/subject.ts': `export default input=>({context:input.context});`,
  'functions/check.ts': `export default input=>[{verdict:'support',statement:'Scripted probe',grounds:[],tier:'advisory'}];`,
} };

test('an unbound workflow takes product and build together, never one of them alone', { skip: await sandboxSkip() }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const h = await openHarness(pg);
  t.after(() => h.close());
  const dir = await mkdtemp(join(tmpdir(), 'hub-target-unbound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await h.workflows.add(await writePack(dir, UNBOUND));
  h.workflows.assign(h.alice.id, UNBOUND.id);
  const subject = { reference: await h.upload(h.alice, Buffer.from('{"synthetic":true}')) };
  const start = (extra: Record<string, unknown>) => h.service.startRunDetailed(h.alice, { pack: UNBOUND.id, inputs: { subject }, ...extra }, h.call());

  const plain = await start({});
  assert.equal(plain.answer.call_result, 'ok', JSON.stringify(plain.answer.errors));
  assert.deepEqual([plain.answer.run!.product, plain.answer.run!.build, plain.answer.run!.root], [undefined, undefined, undefined], 'without both it binds no product line');

  const declared = await start({ product: 'Pasture', build: 'Rel_MEADOW_3_2_9' });
  assert.equal(declared.answer.call_result, 'ok', JSON.stringify(declared.answer.errors));
  const run = declared.answer.run!;
  assert.deepEqual([run.product, run.version, run.build, run.root], ['meadow', '3.2', 'Rel_MEADOW_3_2_9', ROOTS.meadow329], 'any name of the line; the run locks exactly that build');
  const basis = (await h.service.getRun(h.alice, run.run))!.run.target_basis.map((claim) => [claim.statement.data?.field, claim.qualifier.provenance]);
  assert.deepEqual(basis.slice(0, 3), [['product', 'declared'], ['version', 'projected'], ['build', 'declared']]);

  const productOnly = await start({ product: 'Meadow' });
  assert.equal(productOnly.answer.call_result, 'error');
  assert.equal(productOnly.answer.errors[0].code, 'REFERENCE_UNRESOLVED');
  assert.match(productOnly.answer.errors[0].message, /不绑定产品线，不写 build 时不能指定产品/);
  assert.match(productOnly.answer.errors[0].fix ?? '', /product 和 build 两项都写/);

  const buildOnly = await start({ build: 'Rel_MEADOW_3_2_9' });
  assert.equal(buildOnly.answer.call_result, 'error');
  assert.equal(buildOnly.answer.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
  assert.match(buildOnly.answer.errors[0].fix ?? '', /同时写 product/);

  const unknownBuild = await start({ product: 'Meadow', build: 'Rel_MEADOW_9_9_9' });
  assert.equal(unknownBuild.answer.call_result, 'error');
  assert.equal(unknownBuild.answer.errors[0].code, 'REFERENCE_UNRESOLVED');

  // Only a product line the caller can already read: naming one grants nothing.
  h.packs.readable = new Set(['grove']);
  const unreadable = await start({ product: 'Meadow', build: 'Rel_MEADOW_3_2_9' });
  assert.equal(unreadable.answer.call_result, 'error');
  assert.match(unreadable.answer.errors[0].message, /不是这个任务包能用的产品线/);
  const readable = await start({ product: 'Grove', build: 'Rel_GROVE_1_0_4' });
  assert.equal(readable.answer.call_result, 'ok', JSON.stringify(readable.answer.errors));
  assert.equal(readable.answer.run!.root, ROOTS.grove104);
});
