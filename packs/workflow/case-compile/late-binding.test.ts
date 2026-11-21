// End to end on the real engine (a temporary PostgreSQL, the published packs, synthetic documents and scripted models): a plan run
// opened before any case of its recompose run is accepted binds the recomposition result after its start (workflow.json
// from_runs.after_start). Its plan waits (unknown, awaiting_step) until that case's record is accepted in the recompose run, submitted
// alone; the same plan, handed in again unchanged, is then judged and satisfied, while the other case keeps waiting. The local check
// with the run directory's late.json reaches the conclusion the Hub reaches (docs/hub-r4-tasks/t18-late-binding.md, sections 3-5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { temporaryDirectory, writePack } from '../../../hub/runs/api.ts';
import { createCatalogView, osIsolationAvailable } from '../../../hub/rules/api.ts';
import { INDEX } from '../../../hub/runs/engine/store.ts';
import { WorkflowFile } from '../../../contracts/src/pack.ts';
import { fixtureJson, fixtureText } from '../../../tests/fixtures/recompose/index.ts';
import WORKFLOW from './workflow.json' with { type: 'json' };
import { openHub, call } from './testing/hub.ts';
import { stageRecompose } from './testing/stage-recompose.ts';
import { fixture as unitFixture } from './testing/recompose.ts';
import { plan as blockPlan, call as blockCall, fixture as blockFixture } from './testing/blocks.ts';
import { signTypedRuntime } from './testing/typed-fixtures.ts';
import { lockedTreeOf } from './testing/locked-tree.ts';
import { hubProblems, unique, PLAN_REQUIREMENTS } from './testing/hub-answer.ts';
import { itemSubmission, recordFor } from './recompose/tools/submit-records.ts';
import { checkPlanObject } from './tools/check-plan.ts';
import { readLate, type RunLate } from './functions/late.ts';
import { recordSha256 } from './functions/recomposition.ts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// The engine side of late binding (contracts, start, submit, evaluate, the late export) is another task of the same design: until it is
// in this tree, the published case-compile pack is refused at publication for the two new declarations, and this test cannot run.
const lateSupported = WorkflowFile.safeParse(WORKFLOW).success;
const skip = !(await osIsolationAvailable()) ? 'no OS network isolation on this machine (sandbox-exec)'
  : !lateSupported ? 'the Hub in this tree does not implement late binding yet (contracts WorkflowFile refuses from_runs.after_start and workflow.refresh); it runs once the T18 engine side (docs/hub-r4-tasks/t18-late-binding.md sections 1-3) is merged'
  : false;
const PLAN_CHECKED = ['contract_methods', 'commands_known', 'bed_addresses'];

test('a plan waits for its case\'s recomposition, then the same plan is satisfied once that case alone is accepted; check-plan with late.json agrees with the Hub', { skip, timeout: 300_000 }, async () => {
  const postgres = await startPostgres(), temp = await temporaryDirectory('late-binding-e2e-');
  let h: Awaited<ReturnType<typeof openHub>> | undefined;
  try {
    h = await openHub(postgres);
    // The synthetic product, its build and command tree, as the recomposition end-to-end test sets them (recompose/end-to-end.test.ts).
    const f = unitFixture(), build = { name: 'Rel_ORBIT_10_8_0_30', family: 'ORBIT', line: '10.8', base: 'Rel_ORBIT_10_8_0_30', platform: null, built_at: null, released_at: null, sources: {}, root: f.context.root }, info = { root: f.context.root, composition: sha('synthetic composition'), product: 'orbit', build, produced_at: '2026-10-27T00:00:00Z', command_policy: { schema: 'command-policy@1' as const, read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/widget', inverse_prefix: '/commands/no/widget', leading_parameters: 1 }] } };
    h.knowledge.builds = async () => [build];
    h.knowledge.resolveBuild = async () => build;
    h.knowledge.currentRoot = async () => info;
    h.knowledge.rootOfBuild = async () => info;
    h.knowledge.rootInfo = async () => [info];
    const extra = (words: string[], params: any[]) => ({ words, reference: 'tree:' + build.root + '/commands/' + words.join('/'), signatures: [{ id: words.join('/'), reference: 'src:' + build.root + '/xml@1/x/' + words.join('/') + '/arguments', params }] });
    const pool = { name: 'pool', type: 'string' as const, native_type: { name: 'synthetic-string', declaration: 'src:' + build.root + '/xml@1/x/arg', grammar: 'synthetic-tree@1' } };
    const entries = [...f.catalog.entries, extra(['show', 'health'], [pool]), extra(['no', 'widget', 'health', 'interval'], [pool])];
    h.knowledge.catalog = async () => createCatalogView(entries, { reference: 'tree:' + build.root + '/commands', complete: true, caseSensitive: true });
    const productDir = (await writePack(join(temp.path, 'product'), { id: 'orbit', version: '1.0.0', kind: 'product', title: 'ORBIT / COMET', description: 'synthetic source authority', files: { 'product.json': { schema: 'product@1', id: 'orbit', title: 'ORBIT', names: ['ORBIT', 'COMET'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: true }], producers: [{ id: 'declarations', title: 'Synthetic declarations', function: { module: 'functions/declarations.ts' }, inputs: {}, params: { recompose: fixtureJson('product-policy.json') } }] }, 'functions/declarations.ts': 'export default function(){return {entries:[],notes:[]};}' } })).dir;
    const product = await h.registry.publish(h.alice, productDir);
    assert.equal(product.ok, true, JSON.stringify(product));
    await h.registry.activate(h.admin, 'orbit');
    const recompose = await h.registry.publish(h.alice, await stageRecompose('recompose', join(temp.path, 'recompose')));
    assert.equal(recompose.ok, true, JSON.stringify(recompose));
    if (!recompose.ok) return;
    await h.registry.assign(h.admin, h.alice.id, recompose.version.id);
    const put = (id: string, bytes: Uint8Array | string) => h!.external.put(id, { bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes, mediaType: 'application/json' });
    // Two cases of one mind map, and the runner documents of the block plans.
    const external = 'agile:mindmap:synthetic-late';
    put(external, JSON.stringify({ root: { data: { id: 'late-root', text: 'ORBIT / COMET synthetic late' }, children: [JSON.parse(fixtureText('author-pass.km.json')).root.children[0], JSON.parse(fixtureText('author-underdetermined.km.json')).root.children[0]] } }));
    const runtime = blockFixture(), rawContract = structuredClone(runtime.contractDoc) as any;
    rawContract.effects.command.command_scope = ['/commands/widget', '/commands/no/widget', '/commands/show'];
    const contract = signTypedRuntime(rawContract), profile = structuredClone(runtime.profileDoc);
    profile.workbook.autoid_pattern = '^orbit-case-[0-9]+$';
    for (const [name, value] of Object.entries({ contract, profile, inventory: runtime.inventory })) put('doc:doc:late-' + name, JSON.stringify(value));
    const start = { product: 'orbit', build: build.name };

    // The recompose run and, before any of its cases is accepted, the plan run that binds its result after the start.
    const recomposeStart = await h.service.startRunDetailed(h.alice, { ...start, pack: 'recompose', inputs: { subject: { external } }, parameters: { case_depths: [1] } }, call());
    assert.equal(recomposeStart.answer.call_result, 'ok', JSON.stringify(recomposeStart.answer.errors));
    const recomposeRun = recomposeStart.answer.run! as any;
    const recomposeRecord = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: recomposeRun.run })).items[0];
    const planStart = await h.service.startRunDetailed(h.alice, { ...start, pack: 'case-compile', inputs: { subject: { external }, contract: { external: 'doc:doc:late-contract' }, profile: { external: 'doc:doc:late-profile' }, inventory: { external: 'doc:doc:late-inventory' }, recomposition_run: { reference: 'rec:' + recomposeRecord.digest }, recomposition_result: { run: recomposeRun.run } }, parameters: {} }, call());
    assert.equal(planStart.answer.call_result, 'ok', 'a late-bound result needs no accepted submission at start: ' + JSON.stringify(planStart.answer.errors));
    const planRun = planStart.answer.run! as any;
    assert.equal(planRun.items.length, 2);
    for (const item of planRun.items) {
      assert.deepEqual([item.fields.recomposition_late?.run, item.fields.recomposition], [recomposeRun.run, undefined]);
      assert.ok(String(item.summary).endsWith('；重组待受理'), String(item.summary));
    }
    const frozenRecord = (await h.service.exportRun!(h.alice, planRun.run))!;
    assert.deepEqual((frozenRecord.run as any).late_inputs?.map((row: any) => [row.slot, row.run]), [['recomposition_result', recomposeRun.run]]);

    // Each case's record, written by the scripted recomposer, and a plan of each case written against it before it is accepted.
    const files = recomposeRun.items.map((item: any) => ({ item: item.id, method: { kind: 'recomposed', text: '从作者动作取验证方法', sources: [item.fields.atoms[0].reference], basis: '合成依据' } }));
    const records = recomposeRun.items.map((item: any, index: number) => recordFor(item, files[index], 'scripted-recomposer'));
    const recomposeOf = (planItem: any) => recomposeRun.items.findIndex((item: any) => item.fields.node === planItem.fields.recomposition_late.node);
    const planOf = (record: any) => {
      const expected = record.contract.expectation, quote = { reference: expected.quote_ref, text: expected.text };
      const criterion = { id: 'interval_literal', expectation: quote.reference, quote, kind: 'literal', operator: 'abs_found', literal: 'interval=5', rationale: '合成模型选择可观察间隔字段', scope_root: build.root };
      const data = blockPlan([{ kind: 'CONFIG', id: 'configure', call: blockCall('widget health interval pool1 5'), author_step_refs: record.atoms.filter((atom: any) => atom.kind === 'action').map((atom: any) => atom.id) }, { kind: 'OBSERVE_ASSERT', id: 'observe', call: blockCall('show health pool1'), assertions: [{ id: 'assert_interval', output: 'observe', op: 'abs_found', literal: 'interval=5', quote, expectation: quote.reference, criterion: criterion.id }] }, { kind: 'CONFIG', id: 'cleanup', cleanup: true, call: blockCall('no widget health interval pool1') }], [{ expectation: quote.reference, status: 'asserted', assertions: ['assert_interval'] }]) as any;
      data.criteria = [criterion];
      data.block_context = { preconditions: [], causal_links: [{ from: 'configure', to: 'observe', quote }], responders: [] };
      // The receipt is copied before any result exists; the record is named by its own digest, which is what is checked.
      data.recomposition = { receipt: 'rec:' + '0'.repeat(64), record_sha256: recordSha256(record), case_id: record.case.id, slots: [{ slot: 'e1', assertions: ['assert_interval'] }], rebindings: [] };
      return { text: '合成编写消费开运行后受理的重组', quotes: [quote], data };
    };
    const planItems = planRun.items.map((item: any) => ({ item: item.id, handling: 'handled' as const, slots: { plan: [planOf(records[recomposeOf(item)])] } }));
    const submitPlans = () => h!.service.submitResult(h!.alice, { run: planRun.run, model: 'scripted-compiler', items: planItems } as never, call());
    const claimsOf = (answer: any, item: string) => Object.values(answer.result?.partitions ?? {}).flat().filter((row: any) => row.item === item).flatMap((row: any) => row.requirements).filter((requirement: any) => PLAN_CHECKED.includes(requirement.requirement));
    const awaiting = (answer: any, item: string) => claimsOf(answer, item).flatMap((requirement: any) => requirement.claims).filter((claim: any) => claim.statement?.verdict === 'unknown' && claim.statement?.reason === 'awaiting_step' && String(claim.statement?.text ?? '').includes('的重组记录还没有被 Hub 受理'));

    const before = await submitPlans();
    for (const item of planRun.items) {
      assert.ok(awaiting(before, item.id).length > 0, `${item.id} waits for its recomposition: ${JSON.stringify(claimsOf(before, item.id)).slice(0, 2000)}`);
      assert.ok(claimsOf(before, item.id).every((requirement: any) => requirement.status !== 'satisfied'));
    }
    assert.deepEqual((before.result as any)?.locks?.late?.inputs?.map((row: any) => [row.slot, row.run, row.reference]), [['recomposition_result', recomposeRun.run, undefined]], 'no accepted result yet, and the lock says so');

    // The first case's record is submitted alone in the recompose run and accepted; the other case's slot stays empty.
    const first = recomposeOf(planRun.items[0]);
    const single = { run: recomposeRun.run, model: 'scripted-recomposer', items: recomposeRun.items.map((item: any, index: number) => index === first ? itemSubmission(item, files[index], 'scripted-recomposer') : { item: item.id, handling: 'handled', slots: { record: [] } }) };
    const recomposed = await h.service.submitResult(h.alice, single as never, call());
    assert.equal(recomposed.acceptance, 'accepted', JSON.stringify(recomposed.errors));
    const recomposeResult = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: recomposeRun.run, newestFirst: true })).items[0];

    // The same plans, handed in again unchanged: the accepted case is judged now, the other one still waits.
    const after = await submitPlans();
    assert.equal(after.acceptance, 'accepted', JSON.stringify(after.errors));
    const acceptedItem = planRun.items.find((item: any) => recomposeOf(item) === first), waitingItem = planRun.items.find((item: any) => recomposeOf(item) !== first);
    for (const requirement of claimsOf(after, acceptedItem.id)) assert.equal(requirement.status, 'satisfied', JSON.stringify(requirement).slice(0, 2000));
    assert.equal(awaiting(after, acceptedItem.id).length, 0);
    assert.ok(awaiting(after, waitingItem.id).length > 0);
    const lock = (after.result as any)?.locks?.late;
    assert.deepEqual(lock?.inputs?.map((row: any) => [row.slot, row.run, row.reference]), [['recomposition_result', recomposeRun.run, 'rec:' + recomposeResult.digest]]);
    assert.match(String(lock?.refresh), /^[0-9a-f]{64}$/);

    // The late export (GET /run-export/<run>/late): the accepted case's record named by its digest, the other case waiting.
    const service = h.service as unknown as { exportLate?: (user: unknown, run: string) => Promise<unknown> };
    assert.equal(typeof service.exportLate, 'function', 'the runs service answers the late export');
    const answered: any = await service.exportLate!(h.alice, planRun.run);
    const late = [answered, answered?.late, answered?.body, answered?.export].map((candidate) => readLate(candidate, planRun.run)).find((read): read is RunLate => typeof read !== 'string');
    assert.ok(late, 'run-late@1: ' + JSON.stringify(answered).slice(0, 600));
    const overlay = (id: string) => late.items.find((row) => row.id === id)?.late as any;
    assert.equal(overlay(acceptedItem.id)?.recomposition?.record_sha256, recordSha256(records[first]));
    assert.ok(overlay(waitingItem.id)?.recomposition_waiting, JSON.stringify(overlay(waitingItem.id)));

    // check-plan with the run download and late.json reaches the Hub's conclusion for both cases.
    const exported = (await h.service.exportRun!(h.alice, planRun.run))!;
    const frozen = JSON.parse(JSON.stringify(exported.run)) as Record<string, unknown>;
    const view = await h.knowledge.catalog(build.root, 'commands@1');
    assert.ok(view);
    const catalog = lockedTreeOf({ root: build.root, complete: view.complete, entries: view.entries() });
    for (const [index, item] of planRun.items.entries()) {
      const local = checkPlanObject('plan.json', planItems[index], frozen, catalog, late), hubSide = hubProblems(after, item.id, index);
      assert.deepEqual(hubSide.structure, [], item.id);
      const localAwaiting = local.problems.filter((row) => row.code === 'awaiting_step');
      const hubAwaiting = Object.values(after.result?.partitions ?? {}).flat().filter((row: any) => row.item === item.id).flatMap((row: any) => row.requirements).filter((requirement: any) => PLAN_REQUIREMENTS.has(requirement.requirement)).flatMap((requirement: any) => requirement.claims).filter((claim: any) => claim.statement?.reason === 'awaiting_step' && String(claim.statement?.text ?? '').includes('的重组记录还没有被 Hub 受理')).map((claim: any) => claim.statement.text);
      assert.deepEqual([...new Set(localAwaiting.map((row) => row.message))].sort(), [...new Set(hubAwaiting)].sort(), `${item.id}: the same wait, in the same words`);
      assert.deepEqual(unique(local.problems.filter((row) => row.code !== 'awaiting_step')), unique(hubSide.checks), `${item.id}: the same problems of the Hub checks`);
      assert.equal(local.ok, hubSide.checks.length === 0 && hubAwaiting.length === 0, `${item.id}: the verdict of the Hub`);
    }
    // Without late.json the local check cannot judge a late case and says where to get it.
    assert.ok(checkPlanObject('plan.json', planItems[0], frozen, catalog).problems.some((row) => row.pointer === '/run/late.json'));
  } finally {
    await h?.close();
    await temp.remove();
    await postgres.stop();
  }
});
