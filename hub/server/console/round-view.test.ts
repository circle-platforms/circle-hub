import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoundRows,
  caseIdentity,
  collectRoundTree,
  judgmentOfConclusion,
  outboundRunRefs,
  recDigests,
  sameRoundKeys,
  subjectReference,
  ROUND_NO_CONCLUSION,
  ROUND_UNLINKED,
} from './round-view.ts';
import { itemConclusion } from '../text.ts';
import type { ItemProjection, RunRecordView, SourceBinding } from '../../../contracts/src/run.ts';
import type { ItemResult } from '../../../contracts/src/validation.ts';
import type { ExportedJob } from '../../ports.ts';

const sha = 'a'.repeat(64);
const src = `src:${sha}`;
const shaOther = 'b'.repeat(64);
const srcOther = `src:${shaOther}`;
const RUN_BOOKING = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_RECOMPOSE = 'run_01cccccccccccccccccccccccc';
const RUN_PLAN = 'run_01dddddddddddddddddddddddd';
const RUN_MERGE = 'run_01eeeeeeeeeeeeeeeeeeeeeeee';
const RUN_R2 = 'run_01ffffffffffffffffffffffff';
const RUN_P2 = 'run_01gggggggggggggggggggggggg';
const RUN_ORPHAN = 'run_01hhhhhhhhhhhhhhhhhhhhhhhh';
const DIGEST_R = 'c'.repeat(64);
const DIGEST_R2 = 'd'.repeat(64);
const DIGEST_AMBIG_A = 'e'.repeat(64);

const principal = { id: 'usr_01aaaaaaaaaaaaaaaaaaaaaaaa', name: 'synthetic', role: 'member' as const } as const;

function projection(id: string, autoid: string, title?: string): ItemProjection {
  return {
    id,
    label: autoid,
    location: src,
    fields: { case_id: autoid, ...(title === undefined ? {} : { title }), source_ref: src },
  };
}

function itemResult(id: string, label: string, status: 'satisfied' | 'unsatisfied' | 'pending'): ItemResult {
  return {
    item: id,
    label,
    location: src,
    requirements: [{
      requirement: 'plan',
      status,
      ...(status === 'unsatisfied' ? { unsatisfied_reason: 'outcome_mismatch' as const } : {}),
      claims: status === 'satisfied'
        ? [{
          statement: { text: '已按要求核对', verdict: 'support' as const },
          qualifier: { nature: 'fact' as const, provenance: 'observed' as const, marks: [] },
          warrant: { producer: 'function' as const, id: 'synthetic' },
          validity: { status: 'valid' as const, bound: [] },
        }]
        : [],
      layers: [],
    }],
  } as unknown as ItemResult;
}

function subject(reference = src): SourceBinding[] {
  return [{ role: 'subject' as const, reference, slot: 'subject' }];
}

function runView(partial: Partial<RunRecordView> & Pick<RunRecordView, 'run' | 'started_at'>): RunRecordView {
  return {
    pack: 'synthetic-workflow@1.0.0',
    pack_digest: 'f'.repeat(64),
    target_basis: [],
    sources: subject(),
    requirements: [],
    items: [],
    instructions: 'synthetic',
    instructions_digest: '0'.repeat(64),
    product: 'apv',
    version: '1',
    build: 'Beta.1',
    ...partial,
  } as RunRecordView;
}

test('sameRoundKeys require subject src and product/version/build, not pack id', () => {
  const anchor = {
    product: 'apv',
    version: '1',
    build: 'Beta.1',
    sources: subject(),
  };
  assert.equal(sameRoundKeys(anchor, { ...anchor }), true);
  assert.equal(sameRoundKeys(anchor, { ...anchor, build: 'Beta.2' }), false);
  assert.equal(sameRoundKeys(anchor, { ...anchor, sources: subject(srcOther) }), false);
  assert.equal(subjectReference(anchor.sources), src);
});

test('outboundRunRefs collects predecessor, input_defaults and RunId parameters', () => {
  assert.deepEqual(
    outboundRunRefs({
      predecessor: RUN_BOOKING,
      input_defaults: [{ slot: 'expected', predecessor: RUN_RECOMPOSE, reference: `rec:${DIGEST_R}` }],
      parameters: { plan_run: RUN_PLAN, note: 'not-a-run' },
    }).sort(),
    [RUN_BOOKING, RUN_RECOMPOSE, RUN_PLAN].sort(),
  );
  assert.deepEqual(recDigests([{ role: 'expected', reference: `rec:${DIGEST_R}`, slot: 'expected' }, ...subject()]), [DIGEST_R]);
});

test('buildRoundRows uses itemConclusion for wording and counts judgments', () => {
  const one = projection('item-1', '1001', '合成标题甲');
  const two = projection('item-2', '1002', '合成标题乙');
  const satisfied = itemResult('item-1', '1001', 'satisfied');
  const wrong = itemResult('item-2', '1002', 'unsatisfied');
  const conclusionOne = itemConclusion(satisfied, one);
  const conclusionTwo = itemConclusion(wrong, two);
  assert.match(conclusionOne, /判断正确/);
  assert.match(conclusionTwo, /判断错误/);
  assert.equal(caseIdentity(one).title, '合成标题甲');

  const jobs: ExportedJob[] = [{
    job: 'job_1',
    verification_run: RUN_MERGE,
    plan_run: RUN_PLAN,
    items: ['item-1', 'item-2'],
    sha256: sha,
    ended: 'done',
    outcome: 'effective',
    frozen: false,
    result: src,
    device_return: src,
    rows: [
      { item: 'item-1', dynamic_terminal: 'pass' },
      { item: 'item-2', dynamic_terminal: 'fail' },
    ],
  }];

  const { rows, totals } = buildRoundRows({
    projections: [one, two],
    conclusionsByItem: new Map([
      ['item-1', { item: satisfied, original: one }],
      ['item-2', { item: wrong, original: two }],
    ]),
    jobs,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.conclusion, conclusionOne);
  assert.equal(rows[1]!.conclusion, conclusionTwo);
  assert.equal(rows[0]!.deviceAttempts, 1);
  assert.equal(rows[0]!.deviceSha, sha);
  assert.equal(totals.cases, 2);
  assert.equal(totals.correct, 1);
  assert.equal(totals.wrong, 1);
  assert.equal(totals.unknown, 0);
  assert.equal(judgmentOfConclusion(ROUND_NO_CONCLUSION), null);
});

test('missing Hub conclusion stays the empty sentence', () => {
  const one = projection('item-9', '9009');
  const { rows, totals } = buildRoundRows({ projections: [one], conclusionsByItem: new Map(), jobs: [] });
  assert.equal(rows[0]!.conclusion, ROUND_NO_CONCLUSION);
  assert.equal(totals.unknown, 1);
  assert.equal(rows[0]!.deviceAttempts, 0);
});

test('collectRoundTree round-29 shape: input edge joins recompose; booking out; next day separate', async () => {
  const booking = runView({
    run: RUN_BOOKING,
    started_at: '2026-11-14T01:00:00.000Z',
    sources: subject(srcOther),
    product: 'bed',
    build: 'lease',
  });
  const recompose = runView({
    run: RUN_RECOMPOSE,
    started_at: '2026-11-14T02:00:00.000Z',
    // no predecessor — round 29 shape
  });
  const plan = runView({
    run: RUN_PLAN,
    started_at: '2026-11-14T03:00:00.000Z',
    predecessor: RUN_BOOKING,
    input_defaults: [{ slot: 'recomposition_result', predecessor: RUN_RECOMPOSE, reference: `rec:${DIGEST_R}` }],
  });
  const merge = runView({
    run: RUN_MERGE,
    started_at: '2026-11-14T04:00:00.000Z',
    predecessor: RUN_PLAN,
  });
  const recompose2 = runView({
    run: RUN_R2,
    started_at: '2026-11-15T02:00:00.000Z',
  });
  const plan2 = runView({
    run: RUN_P2,
    started_at: '2026-11-15T03:00:00.000Z',
    input_defaults: [{ slot: 'recomposition_result', predecessor: RUN_R2, reference: `rec:${DIGEST_R2}` }],
  });

  const catalog = new Map([
    [RUN_BOOKING, { run: booking, latest: null as { record: string; result: ItemResult } | null, production: null }],
    [RUN_RECOMPOSE, { run: recompose, latest: { record: DIGEST_R, result: itemResult('x', 'x', 'satisfied') }, production: null }],
    [RUN_PLAN, { run: plan, latest: null as { record: string; result: ItemResult } | null, production: null }],
    [RUN_MERGE, { run: merge, latest: null as { record: string; result: ItemResult } | null, production: null }],
    [RUN_R2, { run: recompose2, latest: { record: DIGEST_R2, result: itemResult('y', 'y', 'satisfied') }, production: null }],
    [RUN_P2, { run: plan2, latest: null as { record: string; result: ItemResult } | null, production: null }],
  ]);

  const reader = {
    getRun: async (_user: unknown, id: string) => catalog.get(id) ?? null,
    listRuns: async () => ({ items: [...catalog.values()].map((row) => row.run), next: null }),
    exportSuccessors: async () => ({ run: RUN_MERGE, successors: [] as { run: string }[] }),
  };

  const round1 = await collectRoundTree(reader as never, principal as never, RUN_MERGE);
  assert.ok(round1);
  assert.deepEqual(round1!.runs.map((row) => row.run).sort(), [RUN_RECOMPOSE, RUN_PLAN, RUN_MERGE].sort());
  assert.equal(round1!.runs.some((row) => row.run === RUN_BOOKING), false);
  assert.equal(round1!.unlinked, false);

  const round2 = await collectRoundTree(reader as never, principal as never, RUN_P2);
  assert.ok(round2);
  assert.deepEqual(round2!.runs.map((row) => row.run).sort(), [RUN_R2, RUN_P2].sort());
  assert.equal(round2!.runs.some((row) => row.run === RUN_MERGE), false);
});

test('rec-only reverse: zero or many owners leaves the run unlinked', async () => {
  const orphan = runView({
    run: RUN_ORPHAN,
    started_at: '2026-11-14T05:00:00.000Z',
    sources: [...subject(), { role: 'expected' as const, reference: `rec:${DIGEST_AMBIG_A}`, slot: 'expected' }],
  });
  const twinA = runView({
    run: RUN_RECOMPOSE,
    started_at: '2026-11-14T02:00:00.000Z',
  });
  const twinB = runView({
    run: RUN_PLAN,
    started_at: '2026-11-14T03:00:00.000Z',
  });
  const catalog = new Map([
    [RUN_ORPHAN, { run: orphan, latest: null, production: null }],
    [RUN_RECOMPOSE, { run: twinA, latest: { record: DIGEST_AMBIG_A, result: itemResult('a', 'a', 'satisfied') }, production: null }],
    [RUN_PLAN, { run: twinB, latest: { record: DIGEST_AMBIG_A, result: itemResult('b', 'b', 'satisfied') }, production: null }],
  ]);
  const many = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => catalog.get(id) ?? null,
    listRuns: async () => ({ items: [...catalog.values()].map((row) => row.run), next: null }),
  } as never, principal as never, RUN_ORPHAN);
  assert.ok(many);
  assert.deepEqual(many!.runs.map((row) => row.run), [RUN_ORPHAN]);
  assert.equal(many!.unlinked, true);
  assert.equal(ROUND_UNLINKED.includes('归不进任何一轮'), true);

  const missing = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => id === RUN_ORPHAN ? { run: orphan, latest: null, production: null } : null,
    listRuns: async () => ({ items: [orphan], next: null }),
  } as never, principal as never, RUN_ORPHAN);
  assert.ok(missing);
  assert.equal(missing!.unlinked, true);
  assert.equal(missing!.runs.length, 1);
});
