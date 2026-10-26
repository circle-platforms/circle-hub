import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { RunSummary } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { sha } from './testing/knowledge.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';
import { independenceGap } from './independence.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
let draft: RunSummary;
let handover: string;
const skip = await sandboxSkip();

const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];
/** Synthetic declared model names. They name no family: a family is only a declared model_family_id (A76). */
const DRAFT_MODEL = 'aster-7 temperature=0';
const VERIFIER = 'birch-2';
const TITLES: Record<string, string> = { [ITEM.c1]: '设置 3 区浇灌 15 分钟', [ITEM.c2]: '查看分区状态', [ITEM.c3]: '设置 9 区应报错', [ITEM.c4]: '没有期望结果的用例' };

async function startDraft(harness: Harness, model_identity?:{model_id:string;model_family_id:string}): Promise<{ draft: RunSummary; handover: string }> {
  const started = await harness.service.startRun(harness.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, harness.call('sess-draft'));
  const run = started.run!;
  const at = run.items[0].location;
  const answer = await harness.service.submitResult(
    harness.alice,
    {
      run: run.run,
      model: DRAFT_MODEL,
      ...(model_identity?{model_identity}:{}),
      items: IDS.map((id) =>
        id === ITEM.c1
          ? { item: id, handling: 'handled', slots: { findings: [{ text: '缺少 0 分钟的边界用例', code: 'edge_case_gap', rank: 'major', location: at, quotes: [{ reference: at, text: TITLES[id] }] }] } }
          : { item: id, handling: 'handled', slots: { findings: [] } },
      ),
      cross_item: [{ nature: 'judgment', statement: '反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    harness.call('sess-draft'),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const result = await harness.service.getResult(harness.alice, run.run);
  return { draft: run, handover: `rec:${result!.record}` };
}

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
  ({ draft, handover } = await startDraft(h));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

async function verification(session: string | null, harness = h, input = handover, of = draft): Promise<RunSummary> {
  const answer = await harness.service.startRun(harness.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: input }, map: { reference: map } }, predecessor: of.run }, harness.call(session));
  assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
  return answer.run!;
}

function verdicts(run: RunSummary, model: string, codes: Record<string, string> = {}, verdict = 'PASS'): Record<string, unknown> {
  return {
    run: run.run,
    model,
    items: run.items.map((it) => {
      const findings = it.fields.draft_findings as string[];
      return {
        item: it.id,
        handling: 'handled',
        slots: {
          verification: [
            {
              text: '复核了初评对这个用例的判断',
              code: codes[it.id] ?? 'verified',
              rank: 'minor',
              location: it.location,
              ...(findings.length > 0 ? { grounds: findings } : {}),
              quotes: [{ reference: it.location, text: TITLES[it.id] }],
            },
          ],
        },
      };
    }),
    cross_item: [{ nature: 'judgment', statement: '初评基本正确', grounds: [run.items[0].location], code: 'verdict', rank: verdict }],
  };
}

const itemOf = (result: ValidationResult, id: string): ItemResult => Object.values(result.partitions).flat().find((i) => i.item === id)!;
const verificationOf = (result: ValidationResult, id: string) => itemOf(result, id).requirements.find((r) => r.requirement === 'verification')!;

test('handover by a Hub record reference: the draft result is a bound source; items and references are inherited, judgments are not', { skip }, async () => {
  const run = await verification('sess-verify');
  const bound = run.sources.find((s) => s.slot === 'draft')!;
  assert.deepEqual([bound.reference, bound.role, bound.media_type], [handover, 'artifact_under_verification', 'application/json']);
  assert.deepEqual(run.items.map((i) => i.id), IDS);
  const sha = map.slice('src:'.length);
  assert.equal(run.items[0].location, `src:${sha}/kityminder@1/n/c1aaaaaaaaaa`);
  const findings = run.items[0].fields.draft_findings as string[];
  assert.equal(findings.length, 1);
  assert.ok(findings[0].startsWith(`${handover}#/partitions/delivered/0/requirements/`));
  // no carry-over is offered across a handover: the receiver never inherits the earlier judgments
  assert.ok(run.items.every((i) => i.reuse === undefined));
  assert.equal(run.predecessor, draft.run);
  const answer = await h.service.submitResult(h.alice, verdicts(run, VERIFIER), h.call('sess-verify'));
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const claims = Object.values(answer.result!.partitions).flat().flatMap((i) => i.requirements.flatMap((r) => r.claims));
  assert.ok(claims.every((c) => c.warrant.producer !== 'model' || c.warrant.id === VERIFIER), 'no judgment of the draft is carried into the verification');
  // the verifier's grounds into the draft record resolved inside the run's scope
  const judgment = verificationOf(answer.result!, ITEM.c1).claims.find((c) => c.warrant.producer === 'model')!;
  assert.ok(judgment.resolutions!.some((r) => r.references[0] === findings[0]));
  // it cites the draft (artifact under verification) and quotes the target (subject): the stronger role is the claim's
  assert.equal(judgment.qualifier.source_role, 'subject');
  assert.ok(judgment.validity.bound.includes(handover.slice('rec:'.length)));
});

test('another session and another model name are no family evidence: independence unknown, claims kept', { skip }, async () => {
  // Before the retirement of name inference (owner rule 2026-10-24, sweep A76) a differing model name made this
  // verification independent. A family is now only a declared model_family_id, compared exactly, and no submission
  // declares one yet: the honest result is unknown, never a verdict in either direction.
  const run = await verification('sess-verify-1');
  const answer = await h.service.submitResult(h.alice, verdicts(run, `${VERIFIER} temperature=0`), h.call('sess-verify-1'));
  assert.equal(answer.acceptance, 'accepted');
  for (const id of IDS) {
    const r = verificationOf(answer.result!, id);
    assert.deepEqual([r.status, r.unsatisfied_reason, r.layers[0].terminal], ['unsatisfied', 'independence_unknown', 'judgment'], id);
    const judgment = r.claims.find((c) => c.warrant.producer === 'model')!;
    assert.equal(judgment.warrant.independence, 'unknown');
    assert.ok(judgment.qualifier.marks.includes('independence_declared'), 'the template still accepts a declared independence');
  }
  const final = answer.result!.cross_item.find((c) => c.requirement === 'final')!;
  assert.deepEqual([final.statement.rank, final.warrant.independence], ['PASS', 'unknown']);
  assert.ok(final.qualifier.marks.includes('independence_declared'));
  // The gap that belongs to this unknown, for the receipt the integrator wires with the declared-identity contract.
  const gap = independenceGap({ sessions: ['sess-verify-1'], model: `${VERIFIER} temperature=0` }, { sessions: new Set(['sess-draft']), models: new Set([DRAFT_MODEL]), complete: true });
  assert.match(gap!.missing, /model_family_id/);
  assert.match(gap!.next, /model-identity@1/);
});

test('the same session as the draft is not independent: unsatisfied (independence unknown), claims kept', { skip }, async () => {
  const run = await verification('sess-draft');
  const answer = await h.service.submitResult(h.alice, verdicts(run, VERIFIER), h.call('sess-draft'));
  assert.equal(answer.acceptance, 'accepted');
  const r = verificationOf(answer.result!, ITEM.c1);
  assert.deepEqual([r.status, r.unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
  const judgment = r.claims.find((c) => c.warrant.producer === 'model')!;
  assert.equal(judgment.warrant.independence, 'not_independent');
  assert.ok(judgment.qualifier.marks.includes('independence_declared'));
  // a different start session but the draft's session at submit is just as dependent
  const other = await verification('sess-verify-2');
  const mixed = await h.service.submitResult(h.alice, verdicts(other, VERIFIER), h.call('sess-draft'));
  assert.equal(verificationOf(mixed.result!, ITEM.c2).claims.find((c) => c.warrant.producer === 'model')!.warrant.independence, 'not_independent');
});

test('another configuration or case of a model name is no family evidence either: unknown, not a verdict', { skip }, async () => {
  // The retired rule read a family out of the name (ASTER-7 temperature=1 and the draft's aster-7 temperature=0). Names
  // are not compared any more, so this is unknown; a declared family of the same id would be not_independent.
  const run = await verification('sess-verify-3');
  const answer = await h.service.submitResult(h.alice, verdicts(run, 'ASTER-7 temperature=1'), h.call('sess-verify-3'));
  const r = verificationOf(answer.result!, ITEM.c3);
  assert.deepEqual([r.status, r.unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
  assert.equal(r.claims.find((c) => c.warrant.producer === 'model')!.warrant.independence, 'unknown');
});

test('an unobserved session refuses an independent start before binding', { skip }, async () => {
  const answer=await h.service.startRun(h.alice,{pack:'toy-verify',product:'Meadow',version:'3.2',inputs:{draft:{reference:handover},map:{reference:map}},predecessor:draft.run},h.call(null));
  assert.equal(answer.call_result,'error');
  assert.ok(answer.errors.some(e=>e.fix?.includes('Circle-Session-Id')));
});

test('a verdict inconsistent with the dispositions is a violation routed into repair, not a whole rejection', { skip }, async () => {
  const run = await verification('sess-verify-5');
  const answer = await h.service.submitResult(h.alice, verdicts(run, VERIFIER, { [ITEM.c2]: 'refuted' }), h.call('sess-verify-5'));
  assert.equal(answer.acceptance, 'accepted');
  assert.deepEqual(answer.errors.map((e) => [e.code, e.item, e.rounds_left]), [['toy-verify.inconsistent', ITEM.c2, 1]]);
  const r = verificationOf(answer.result!, ITEM.c2);
  assert.deepEqual(r.layers, [{ layer: 'static', terminal: 'violation', code: 'toy-verify.inconsistent', tier: 'blocking', attribution: 'producer_error' }]);
  assert.equal(r.unsatisfied_reason, 'outcome_mismatch');
  assert.deepEqual([verificationOf(answer.result!, ITEM.c1).status, verificationOf(answer.result!, ITEM.c1).unsatisfied_reason], ['unsatisfied', 'independence_unknown'], 'the consistent item still fails on independence, not on its outcome');
  // PARTIAL with the same dispositions is consistent
  const partial = await h.service.submitResult(h.alice, verdicts(run, VERIFIER, { [ITEM.c2]: 'refuted' }, 'PARTIAL'), h.call('sess-verify-5'));
  assert.deepEqual(partial.errors, []);
});

test('a handover record the caller may not read is unavailable; a verifier cannot cite records outside the run', { skip }, async () => {
  h.workflows.assign(h.bob.id, 'toy-verify');
  const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
  const theirs = await h.service.startRun(h.bob, { pack: 'toy-verify', product: 'Meadow', inputs: { draft: { reference: handover }, map: { reference: bobMap } } }, h.call());
  assert.deepEqual(theirs.errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/inputs/draft']]);
  h.workflows.unassign(h.bob.id, 'toy-verify');
  const run = await verification('sess-verify-6');
  const args = verdicts(run, VERIFIER);
  const outside = `rec:${'f'.repeat(64)}#/partitions/delivered/0`;
  ((args.items as { slots: { verification: { grounds?: string[] }[] } }[])[1].slots.verification[0]).grounds = [outside];
  const answer = await h.service.submitResult(h.alice, args, h.call('sess-verify-6'));
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['REFERENCE_UNRESOLVED', '/items/1/slots/verification/0/grounds/0']]);
});

test('without accepts_declared_independence the declared independence is not accepted (A04 R[4])', { skip }, async () => {
  const strict = await openHarness(postgres, { verifyAcceptsDeclared: false });
  try {
    const previous = map;
    map = await strict.upload(strict.alice, toyMap(standardDocument()));
    const lineage = await startDraft(strict);
    const run = await verification('sess-verify-7', strict, lineage.handover, lineage.draft);
    const answer = await strict.service.submitResult(strict.alice, verdicts(run, VERIFIER), strict.call('sess-verify-7'));
    const r = verificationOf(answer.result!, ITEM.c1);
    assert.deepEqual([r.status, r.unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
    const judgment = r.claims.find((c) => c.warrant.producer === 'model')!;
    assert.equal(judgment.warrant.independence, 'unknown');
    assert.ok(!judgment.qualifier.marks.includes('independence_declared'));
    map = previous;
  } finally {
    await strict.close();
  }
});

// ---------------------------------------------------------------- lineage (A04: the drafter can never sign the conclusion)

/** A draft run of alice's in one session, submitted by one model in another session (findings on c1, optional contexts). */
async function draftBy(start: string, submit: string, model: string, options: { predecessor?: string; contexts?: boolean; reuse?: Record<string, string> } = {}): Promise<{ run: RunSummary; handover: string }> {
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, ...(options.predecessor ? { predecessor: options.predecessor } : {}) }, h.call(start));
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!;
  const at = run.items[0].location;
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: run.run,
      model,
      items: IDS.map((id) => {
        if (options.reuse?.[id] !== undefined) return { item: id, handling: 'handled', reuse: options.reuse[id] };
        const context = options.contexts ? { context: sha(`context of ${id} by ${model}`) } : {};
        return id === ITEM.c1
          ? { item: id, handling: 'handled', ...context, slots: { findings: [{ text: '缺少 0 分钟的边界用例', code: 'edge_case_gap', rank: 'major', location: at, quotes: [{ reference: at, text: TITLES[id] }] }] } }
          : { item: id, handling: 'handled', ...context, slots: { findings: [] } };
      }),
      cross_item: [{ nature: 'judgment', statement: '反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call(submit),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  return { run, handover: `rec:${(await h.service.getResult(h.alice, run.run))!.record}` };
}

const independenceIn = (result: ValidationResult): string[] =>
  unique(Object.values(result.partitions).flat().flatMap((i) => i.requirements.filter((r) => r.requirement === 'verification').flatMap((r) => r.claims.filter((c) => c.warrant.producer === 'model').map((c) => c.warrant.independence ?? 'none'))));

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function verified(run: RunSummary, model: string, session: string): Promise<{ statuses: string[]; independence: string[]; final: string | undefined }> {
  const answer = await h.service.submitResult(h.alice, verdicts(run, model), h.call(session));
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const result = answer.result!;
  return {
    statuses: unique(IDS.map((id) => verificationOf(result, id).status)),
    independence: independenceIn(result),
    final: result.cross_item.find((c) => c.requirement === 'final')?.warrant.independence,
  };
}

test('a predecessor of the same pack is the author of an independent judgment (A04)', { skip }, async () => {
  const lineage = await draftBy('sess-same-author', 'sess-same-author', DRAFT_MODEL);
  const started = await h.service.startRun(
    h.alice,
    { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, predecessor: lineage.run.run },
    h.call('sess-same-judge'),
  );
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: started.run!.run,
      model: VERIFIER,
      items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call('sess-same-judge'),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const findings = Object.values(answer.result!.partitions).flat().find((item) => item.item === ITEM.c1)!.requirements.find((requirement) => requirement.requirement === 'findings')!;
  assert.deepEqual([findings.status, findings.unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
});

test('replaying an accepted verification from the drafter session is not independent (A04)', { skip }, async () => {
  const lineage = await draftBy('sess-replay-draft', 'sess-replay-draft', DRAFT_MODEL);
  const run = await verification('sess-replay-verify', h, lineage.handover, lineage.run);
  const body = verdicts(run, VERIFIER);
  const accepted = await h.service.submitResult(h.alice, body, h.call('sess-replay-verify'));
  assert.equal(accepted.acceptance, 'accepted', JSON.stringify(accepted.errors));
  assert.deepEqual([verificationOf(accepted.result!, ITEM.c1).status, verificationOf(accepted.result!, ITEM.c1).unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
  // The body is unchanged. The session is the drafter's, so this call is not the verifier's receipt.
  const replayed = await h.service.submitResult(h.alice, body, h.call('sess-replay-draft'));
  assert.equal(replayed.acceptance, 'accepted', JSON.stringify(replayed.errors));
  const again = verificationOf(replayed.result!, ITEM.c1);
  assert.equal(again.status, 'unsatisfied');
  assert.equal(again.unsatisfied_reason, 'independence_unknown');
  const retry = await h.service.submitResult(h.alice, body, h.call('sess-replay-verify'));
  assert.equal(retry.result!.trace, accepted.result!.trace);
});

test('a verification revised by its own verifier stays independent of the draft; revised by the drafter it is not', { skip }, async () => {
  const lineage = await draftBy('sess-r-draft', 'sess-r-draft', DRAFT_MODEL);
  const v1 = await verification('sess-r-verify', h, lineage.handover, lineage.run);
  assert.deepEqual(await verified(v1, VERIFIER, 'sess-r-verify'), { statuses: ['unsatisfied'], independence: ['unknown'], final: 'unknown' });
  // the verifier revises its own verification: still judged against the draft, not against its own first revision
  const v2 = await verification('sess-r-verify', h, lineage.handover, v1);
  assert.deepEqual(await verified(v2, VERIFIER, 'sess-r-verify'), { statuses: ['unsatisfied'], independence: ['unknown'], final: 'unknown' });
  // the drafter revises the verification: not independent of the draft, whatever the revision before it
  const v3 = await verification('sess-r-draft', h, lineage.handover, v2);
  assert.deepEqual(await verified(v3, DRAFT_MODEL, 'sess-r-draft'), { statuses: ['unsatisfied'], independence: ['not_independent'], final: 'not_independent' });
  // the drafter's model family from a fresh session (a dated alias) is just as dependent
  const v4 = await verification('sess-r-fresh', h, lineage.handover, v3);
  // A dated alias of the draft's model name is no family evidence: unknown, not a verdict in either direction.
  assert.deepEqual(await verified(v4, 'aster-7-20261001', 'sess-r-fresh'), { statuses: ['unsatisfied'], independence: ['unknown'], final: 'unknown' });
});

test('every drafter of the lineage counts: the producer of an older handed-over result and a later one', { skip }, async () => {
  // the draft gets an accepted submission by the draft model, then another one by a second model
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call('sess-o-start'));
  const draftRun = started.run!;
  const first = await h.service.submitResult(h.alice, { run: draftRun.run, model: DRAFT_MODEL, items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] }, h.call('sess-o-1'));
  assert.equal(first.acceptance, 'accepted');
  const older = `rec:${(await h.service.getResult(h.alice, draftRun.run))!.record}`;
  const second = await h.service.submitResult(h.alice, { run: draftRun.run, model: 'cedar-3', items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '偏弱', grounds: [], code: 'draft_level', rank: 'P5' }] }, h.call('sess-o-2'));
  assert.equal(second.acceptance, 'accepted');
  // the older result handed over and verified by the model that produced it, from a fresh session: not independent
  const byFirst = await verification('sess-o-v1', h, older, draftRun);
  assert.deepEqual((await verified(byFirst, DRAFT_MODEL, 'sess-o-v1')).independence, ['not_independent']);
  // the second drafter is a drafter of the same work
  const bySecond = await verification('sess-o-v2', h, older, draftRun);
  assert.deepEqual((await verified(bySecond, 'cedar-3', 'sess-o-v2')).independence, ['not_independent']);
  // a verifier of another family in another session is independent
  const byOther = await verification('sess-o-v3', h, older, draftRun);
  assert.deepEqual(await verified(byOther, VERIFIER, 'sess-o-v3'), { statuses: ['unsatisfied'], independence: ['unknown'], final: 'unknown' });
});

test('judgments carried into a revision of the draft keep their author: the first drafter cannot verify the revision', { skip }, async () => {
  const d1 = await draftBy('sess-c-1', 'sess-c-1', DRAFT_MODEL, { contexts: true });
  const d2Start = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, predecessor: d1.run.run }, h.call('sess-c-2'));
  const offer = d2Start.run!.items.find((i) => i.id === ITEM.c1)!.reuse;
  assert.ok(offer, 'c1 is offered for carry-over');
  const d2 = await (async () => {
    const run = d2Start.run!;
    const answer = await h.service.submitResult(
      h.alice,
      {
        run: run.run,
        model: 'cedar-3',
        items: IDS.map((id) => (id === ITEM.c1 ? { item: id, handling: 'handled', reuse: offer } : { item: id, handling: 'handled', slots: { findings: [] } })),
        cross_item: [{ nature: 'judgment', statement: '反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' }],
      },
      h.call('sess-c-2'),
    );
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    return { run, handover: `rec:${(await h.service.getResult(h.alice, run.run))!.record}` };
  })();
  // the carried judgment of c1 is the first drafter's
  const handed = (await h.service.getResult(h.alice, d2.run.run))!.result;
  assert.ok(Object.values(handed.partitions).flat().find((i) => i.item === ITEM.c1)!.requirements.some((r) => r.claims.some((c) => c.warrant.id === DRAFT_MODEL)));
  const v = await verification('sess-c-v', h, d2.handover, d2.run);
  assert.deepEqual((await verified(v, DRAFT_MODEL, 'sess-c-v')).independence, ['not_independent']);
});

test('a handover from outside the predecessor lineage is refused before anything is read', { skip }, async () => {
  const lineage = await draftBy('sess-f-draft', 'sess-f-draft', DRAFT_MODEL);
  // an unrelated review of the same user, submitted by another session and model
  const unrelated = await draftBy('sess-f-other', 'sess-f-other', VERIFIER);
  const before = (await h.service.listRuns(h.alice, { limit: 500 })).items.length;
  const reads = h.external.reads.length;
  const refused = await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: lineage.handover }, map: { reference: map } }, predecessor: unrelated.run.run }, h.call('sess-f-draft'));
  assert.deepEqual(refused.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/predecessor']]);
  assert.ok(refused.errors[0].fix?.includes(lineage.run.run), 'the fix names the run the handed-over record belongs to');
  // a fact-only run as predecessor says nothing about the draft either
  const locate = await h.service.startRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call('sess-f-x'));
  const viaLocate = await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: lineage.handover }, map: { reference: map } }, predecessor: locate.run!.run }, h.call('sess-f-draft'));
  assert.deepEqual(viaLocate.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/predecessor']]);
  assert.equal((await h.service.listRuns(h.alice, { limit: 500 })).items.length, before + 1, 'only the fact-only run was started');
  assert.equal(h.external.reads.length, reads, 'nothing was read for the refused starts');
  // the verification of the draft with its own lineage starts
  assert.equal((await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: lineage.handover }, map: { reference: map } }, predecessor: lineage.run.run }, h.call('sess-f-v'))).call_result, 'ok');
});

for(const sameFamily of [false,true])test(`explicit model identities survive storage and handover with exact family comparison: ${sameFamily}`,{skip},async t=>{
 const local=await openHarness(postgres);t.after(()=>local.close());
 await local.upload(local.alice,toyMap(standardDocument()));
 const authored=await startDraft(local,{model_id:'synthetic-model-draft',model_family_id:'synthetic-family-a'});
 const run=await verification('synthetic-verifier-session',local,authored.handover,authored.draft);
 const submitted={...verdicts(run,'shared display name'),model_identity:{model_id:'synthetic-model-verify',model_family_id:sameFamily?'synthetic-family-a':'synthetic-family-b'}};
 const answer=await local.service.submitResult(local.alice,submitted,local.call('synthetic-verifier-session'));
 assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
 const requirement=verificationOf(answer.result!,ITEM.c1);
 assert.equal(requirement.status,sameFamily?'unsatisfied':'satisfied');
 const judgment=requirement.claims.find(claim=>claim.warrant.producer==='model')!;
 assert.equal(judgment.warrant.id,'synthetic-model-verify');
 assert.equal(judgment.warrant.independence,sameFamily?'not_independent':'model_family_declared');
});

test('a later declaration cannot backfill an older author submission even when its model id is identical',{skip},async t=>{
 const local=await openHarness(postgres);t.after(()=>local.close());
 await local.upload(local.alice,toyMap(standardDocument()));
 const authored=await startDraft(local);
 const {submissionsOf}=await import('./store.ts');
 const [legacy]=await submissionsOf(local.kit.store,authored.draft.run);assert.ok(legacy);
 const original=JSON.stringify(legacy.body);
 const modern={...(legacy.body as Record<string,unknown>),model_identity:{model_id:DRAFT_MODEL,model_family_id:'synthetic-family-a'}};
 const accepted=await local.service.submitResult(local.alice,modern,local.call('sess-draft'));assert.equal(accepted.acceptance,'accepted');
 const result=await local.service.getResult(local.alice,authored.draft.run);assert.ok(result);
 const run=await verification('synthetic-modern-verifier',local,'rec:'+result.record,authored.draft);
 const answer=await local.service.submitResult(local.alice,{...verdicts(run,VERIFIER),model_identity:{model_id:'synthetic-verifier',model_family_id:'synthetic-family-b'}},local.call('synthetic-modern-verifier'));
 assert.equal(answer.acceptance,'accepted');
 const requirement=verificationOf(answer.result!,ITEM.c1);assert.equal(requirement.unsatisfied_reason,'independence_unknown');
 assert.equal(requirement.claims.find(claim=>claim.warrant.producer==='model')!.warrant.independence,'unknown');
 assert.equal(JSON.stringify((await local.kit.store.get(legacy.digest))!.body),original,'the legacy author record is immutable');
});
