import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoundRows,
  caseIdentity,
  collectRoundTree,
  outboundRunRefs,
  recDigests,
  sameRoundKeys,
  subjectReference,
  ROUND_NO_CONCLUSION,
  ROUND_RUNS_SCANNED,
  ROUND_UNLINKED,
} from './round-view.ts';
import { itemConclusion, itemConclusionParts } from '../text.ts';
import type { ItemProjection, RunRecordView, SourceBinding } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
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

function projection(id: string, label: string, summary?: string): ItemProjection {
  return {
    id,
    label,
    location: src,
    fields: {},
    ...(summary === undefined ? {} : { summary }),
  };
}

function itemResult(id: string, label: string, status: 'satisfied' | 'unsatisfied' | 'pending', opts: { model?: boolean; titleInStatement?: string } = {}): ItemResult {
  const statement = opts.titleInStatement ?? (status === 'satisfied' ? '已按要求核对' : '核对发现错误');
  return {
    item: id,
    label,
    location: src,
    requirements: [{
      requirement: 'check',
      status,
      ...(status === 'unsatisfied' ? { unsatisfied_reason: 'outcome_mismatch' as const } : {}),
      claims: status === 'satisfied'
        ? [{
          statement: { text: statement, verdict: 'support' as const },
          qualifier: { nature: opts.model ? 'judgment' as const : 'fact' as const, provenance: 'observed' as const, marks: [] },
          warrant: { producer: opts.model ? 'model' as const : 'function' as const, id: 'synthetic' },
          validity: { status: 'valid' as const, bound: [] },
        }]
        : status === 'pending'
          ? [{
            statement: { text: statement, verdict: 'unknown' as const },
            qualifier: { nature: 'unknown' as const, provenance: 'observed' as const, marks: [] },
            warrant: { producer: 'function' as const, id: 'synthetic' },
            validity: { status: 'valid' as const, bound: [] },
          }]
          : [],
      layers: [],
    }],
  } as unknown as ItemResult;
}

function subject(reference = src): SourceBinding[] {
  return [{ role: 'subject' as const, reference, slot: 'subject', label: '合成来源甲' }];
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
    product: 'product-a',
    version: '1',
    build: 'build-1',
    ...partial,
  } as RunRecordView;
}

function asValidation(item: ItemResult): ValidationResult {
  return {
    acceptance: 'accepted',
    partitions: { delivered: [item], rejected: [], incomplete: [], quarantined: [] },
  } as unknown as ValidationResult;
}

test('sameRoundKeys require subject src and product/version/build', () => {
  const anchor = {
    product: 'product-a',
    version: '1',
    build: 'build-1',
    sources: subject(),
  };
  assert.equal(sameRoundKeys(anchor, { ...anchor }), true);
  assert.equal(sameRoundKeys(anchor, { ...anchor, build: 'build-2' }), false);
  assert.equal(sameRoundKeys(anchor, { ...anchor, sources: subject(srcOther) }), false);
  assert.equal(subjectReference(anchor.sources), src);
});

test('outboundRunRefs collects predecessor, input_defaults and RunId parameters', () => {
  assert.deepEqual(
    outboundRunRefs({
      predecessor: RUN_BOOKING,
      input_defaults: [{ slot: 'slot-input', predecessor: RUN_RECOMPOSE, reference: `rec:${DIGEST_R}` }],
      parameters: { param_run: RUN_PLAN, note: 'not-a-run' },
    }).sort(),
    [RUN_BOOKING, RUN_RECOMPOSE, RUN_PLAN].sort(),
  );
  assert.deepEqual(recDigests([{ role: 'expected', reference: `rec:${DIGEST_R}`, slot: 'slot-input' }, ...subject()]), [DIGEST_R]);
});

test('buildRoundRows uses itemConclusionParts for wording and structured counts', () => {
  const one = projection('item-1', '1001', '合成标题甲');
  const two = projection('item-2', '1002', '合成标题乙');
  const three = projection('item-3', '1003', '标题含判断错误字样');
  const four = projection('item-4', '1004', '合成未知');
  const satisfied = itemResult('item-1', '1001', 'satisfied');
  const wrong = itemResult('item-2', '1002', 'unsatisfied');
  const modelOk = itemResult('item-3', '1003', 'satisfied', { model: true, titleInStatement: '含判断错误字样的主张仍正确' });
  const pending = itemResult('item-4', '1004', 'pending', { titleInStatement: '还含判断正确字样但状态未知' });
  const partsOne = itemConclusionParts(satisfied, one);
  const partsTwo = itemConclusionParts(wrong, two);
  const partsThree = itemConclusionParts(modelOk, three);
  const partsFour = itemConclusionParts(pending, four);
  assert.equal(partsOne.judgment, '正确');
  assert.equal(partsOne.status, '已确认');
  assert.equal(partsTwo.judgment, '错误');
  assert.equal(partsThree.judgment, '正确');
  assert.equal(partsThree.status, '未确认');
  assert.equal(partsFour.judgment, null);
  assert.equal(partsFour.status, '未知');
  assert.match(partsThree.text, /判断正确/);
  assert.match(partsThree.text, /判断错误/); // title/statement noise must not drive the count
  assert.equal(caseIdentity(one).title, '合成标题甲');
  assert.equal(caseIdentity(one).id, '1001');

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
    projections: [one, two, three, four],
    conclusionsByItem: new Map([
      ['item-1', { item: satisfied, original: one }],
      ['item-2', { item: wrong, original: two }],
      ['item-3', { item: modelOk, original: three }],
      ['item-4', { item: pending, original: four }],
    ]),
    jobs,
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.conclusion, itemConclusion(satisfied, one));
  assert.equal(totals.cases, 4);
  assert.equal(totals.correct, 1);
  assert.equal(totals.unconfirmed, 1);
  assert.equal(totals.wrong, 1);
  assert.equal(totals.unknown, 1);
  assert.equal(totals.batches, 1);
});

test('missing Hub conclusion stays unknown without keyword matching', () => {
  const one = projection('item-9', '9009');
  const { rows, totals } = buildRoundRows({ projections: [one], conclusionsByItem: new Map(), jobs: [] });
  assert.equal(rows[0]!.conclusion, ROUND_NO_CONCLUSION);
  assert.equal(totals.unknown, 1);
  assert.equal(rows[0]!.judgment, null);
  assert.equal(rows[0]!.deviceAttempts, 0);
});

test('collectRoundTree: booking out; next-day same-key with real rec: sources stays separate', async () => {
  const booking = runView({
    run: RUN_BOOKING,
    started_at: '2026-11-14T01:00:00.000Z',
    sources: subject(srcOther),
    product: 'product-b',
    build: 'build-lease',
  });
  const recompose = runView({
    run: RUN_RECOMPOSE,
    started_at: '2026-11-14T02:00:00.000Z',
  });
  const plan = runView({
    run: RUN_PLAN,
    started_at: '2026-11-14T03:00:00.000Z',
    predecessor: RUN_BOOKING,
    input_defaults: [{ slot: 'slot-input', predecessor: RUN_RECOMPOSE, reference: `rec:${DIGEST_R}` }],
    sources: [
      ...subject(),
      { role: 'expected' as const, reference: `rec:${DIGEST_R}`, slot: 'slot-input' },
    ],
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
    input_defaults: [{ slot: 'slot-input', predecessor: RUN_R2, reference: `rec:${DIGEST_R2}` }],
    // Real shape: rec: source alongside input_defaults (review 9.1 / 7.3).
    sources: [
      ...subject(),
      { role: 'expected' as const, reference: `rec:${DIGEST_R2}`, slot: 'slot-input' },
    ],
  });

  const catalog = new Map([
    [RUN_BOOKING, { run: booking, latest: null as { record: string; result: ValidationResult } | null, production: null }],
    [RUN_RECOMPOSE, { run: recompose, latest: { record: DIGEST_R, result: asValidation(itemResult('x', 'x', 'satisfied')) }, production: null }],
    [RUN_PLAN, { run: plan, latest: null as { record: string; result: ValidationResult } | null, production: null }],
    [RUN_MERGE, { run: merge, latest: null as { record: string; result: ValidationResult } | null, production: null }],
    [RUN_R2, { run: recompose2, latest: { record: DIGEST_R2, result: asValidation(itemResult('y', 'y', 'satisfied')) }, production: null }],
    [RUN_P2, { run: plan2, latest: null as { record: string; result: ValidationResult } | null, production: null }],
  ]);

  const owners = new Map<string, string>([
    [DIGEST_R, RUN_RECOMPOSE],
    [DIGEST_R2, RUN_R2],
  ]);

  let getRuns = 0;
  const reader = {
    getRun: async (_user: unknown, id: string) => {
      getRuns += 1;
      return catalog.get(id) ?? null;
    },
    listRuns: async () => ({ items: [...catalog.values()].map((row) => row.run), next: null }),
    exportSuccessors: async () => ({ run: RUN_MERGE, successors: [] as { run: string }[] }),
    runOfResult: async (_user: unknown, digest: string) => owners.get(digest) ?? null,
  };

  const round1 = await collectRoundTree(reader as never, principal as never, RUN_MERGE);
  assert.ok(round1);
  assert.deepEqual(round1!.runs.map((row) => row.run).sort(), [RUN_RECOMPOSE, RUN_PLAN, RUN_MERGE].sort());
  assert.equal(round1!.runs.some((row) => row.run === RUN_BOOKING), false);
  assert.equal(round1!.runs.some((row) => row.run === RUN_R2 || row.run === RUN_P2), false, 'day-2 same-key must not merge via rec: on outsiders');
  assert.equal(round1!.unlinked, false);

  const round2 = await collectRoundTree(reader as never, principal as never, RUN_P2);
  assert.ok(round2);
  assert.deepEqual(round2!.runs.map((row) => row.run).sort(), [RUN_R2, RUN_P2].sort());
  assert.equal(round2!.runs.some((row) => row.run === RUN_MERGE), false);

  // Scale: getRun count stays on the component, not on every listed same-key run.
  const before = getRuns;
  const again = await collectRoundTree(reader as never, principal as never, RUN_MERGE);
  assert.ok(again);
  const used = getRuns - before;
  assert.ok(used <= 8, `getRun stayed near component size, got ${used}`);
  assert.ok(used < ROUND_RUNS_SCANNED);
});

test('rec-only reverse: zero or many owners leaves the anchor unlinked', async () => {
  const orphan = runView({
    run: RUN_ORPHAN,
    started_at: '2026-11-14T05:00:00.000Z',
    sources: [...subject(), { role: 'expected' as const, reference: `rec:${DIGEST_AMBIG_A}`, slot: 'slot-input' }],
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
    [RUN_RECOMPOSE, { run: twinA, latest: { record: DIGEST_AMBIG_A, result: asValidation(itemResult('a', 'a', 'satisfied')) }, production: null }],
    [RUN_PLAN, { run: twinB, latest: { record: DIGEST_AMBIG_A, result: asValidation(itemResult('b', 'b', 'satisfied')) }, production: null }],
  ]);
  const many = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => catalog.get(id) ?? null,
    listRuns: async () => ({ items: [...catalog.values()].map((row) => row.run), next: null }),
    runOfResult: async () => null,
  } as never, principal as never, RUN_ORPHAN);
  assert.ok(many);
  assert.deepEqual(many!.runs.map((row) => row.run), [RUN_ORPHAN]);
  assert.equal(many!.unlinked, true);
  assert.match(ROUND_UNLINKED, /状态未知/);

  const missing = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => id === RUN_ORPHAN ? { run: orphan, latest: null, production: null } : null,
    listRuns: async () => ({ items: [orphan], next: null }),
    runOfResult: async () => null,
  } as never, principal as never, RUN_ORPHAN);
  assert.ok(missing);
  assert.equal(missing!.unlinked, true);
  assert.equal(missing!.runs.length, 1);
});
