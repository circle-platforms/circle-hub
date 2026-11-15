import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoundRows,
  caseIdentity,
  collectRoundTree,
  loadJobs,
  mergeMemberItems,
  outboundRunRefs,
  recDigests,
  roundDevicePage,
  sameRoundKeys,
  subjectReference,
  ROUND_DEVICE_UNREADABLE,
  ROUND_JOBS_FORBIDDEN,
  ROUND_NO_CONCLUSION,
  ROUND_NO_SUBJECT,
  ROUND_RUNS_SCANNED,
  ROUND_SAME_KEY_UNLINKED,
  ROUND_SUCCESSORS_OPAQUE,
  ROUND_UNLINKED,
} from './round-view.ts';
import { itemConclusion, itemConclusionParts } from '../text.ts';
import type { ItemProjection, RunRecordView, SourceBinding } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { ExportedJob } from '../../ports.ts';
import type { PageContext } from './context.ts';

const sha = 'a'.repeat(64);
const src = `src:${sha}`;
const shaOther = 'b'.repeat(64);
const srcOther = `src:${shaOther}`;
const shaDevice = '1'.repeat(64);
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

/** Recompose-shaped: label is the case id, no summary (title lives in fields elsewhere). */
function recomposeProjection(id: string, autoid: string): ItemProjection {
  return { id, label: autoid, location: src, fields: { title: `合成标题-${autoid}` } };
}

/** Plan/merge-shaped: label is the title, summary is step counts (autoid in fields). */
function planProjection(id: string, title: string, steps: number, expects: number, autoid: string): ItemProjection {
  return {
    id,
    label: title,
    summary: `${steps} 步；${expects} 个期望结果`,
    location: src,
    fields: { autoid },
  };
}

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

test('caseIdentity keeps pack label/summary; dedupes by projection.id not label', () => {
  const recompose = recomposeProjection('n/aaa', '990000000000000001');
  const planA = planProjection('n/aaa', '合成标题相同', 3, 2, '990000000000000001');
  const planB = planProjection('n/bbb', '合成标题相同', 4, 1, '990000000000000002');
  assert.equal(caseIdentity(recompose).id, 'n/aaa');
  assert.equal(caseIdentity(recompose).label, '990000000000000001');
  assert.equal(caseIdentity(recompose).summary, '');
  assert.equal(caseIdentity(planA).label, '合成标题相同');
  assert.match(caseIdentity(planA).summary, /3 步/);
  // Same title on two plan items must stay two rows when ids differ.
  const { rows, totals } = buildRoundRows({
    projections: [planA, planB],
    conclusionsByItem: new Map(),
    jobs: [],
  });
  assert.equal(rows.length, 2);
  assert.equal(totals.cases, 2);
  assert.equal(rows[0]!.label, '合成标题相同');
  assert.equal(rows[1]!.label, '合成标题相同');
});

test('buildRoundRows uses itemConclusionParts for wording and structured counts', () => {
  const one = planProjection('item-1', '合成标题甲', 2, 1, '1001');
  const two = planProjection('item-2', '合成标题乙', 2, 1, '1002');
  const three = planProjection('item-3', '标题含判断错误字样', 1, 1, '1003');
  const four = recomposeProjection('item-4', '1004');
  const satisfied = itemResult('item-1', '合成标题甲', 'satisfied');
  const wrong = itemResult('item-2', '合成标题乙', 'unsatisfied');
  const modelOk = itemResult('item-3', '标题含判断错误字样', 'satisfied', { model: true, titleInStatement: '含判断错误字样的主张仍正确' });
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
  assert.equal(caseIdentity(one).id, 'item-1');
  assert.equal(caseIdentity(one).label, '合成标题甲');

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

test('collectRoundTree discloses when exportSuccessors is opaque and when subject is missing', async () => {
  const recompose = runView({ run: RUN_RECOMPOSE, started_at: '2026-11-14T02:00:00.000Z' });
  const merge = runView({
    run: RUN_MERGE,
    started_at: '2026-11-14T04:00:00.000Z',
    predecessor: RUN_RECOMPOSE,
  });
  const catalog = new Map([
    [RUN_RECOMPOSE, { run: recompose, latest: null, production: null }],
    [RUN_MERGE, { run: merge, latest: null, production: null }],
  ]);
  const opaque = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => catalog.get(id) ?? null,
    listRuns: async () => ({ items: [...catalog.values()].map((row) => row.run), next: null }),
    exportSuccessors: async () => null,
  } as never, principal as never, RUN_RECOMPOSE);
  assert.ok(opaque);
  assert.equal(opaque!.successorsOpaque, true);
  assert.match(ROUND_SUCCESSORS_OPAQUE, /不能读取后继/);

  const bare = runView({
    run: RUN_BOOKING,
    started_at: '2026-11-14T01:00:00.000Z',
    sources: [{ role: 'hint' as const, reference: src, slot: 'hint' }],
  });
  const alone = await collectRoundTree({
    getRun: async () => ({ run: bare, latest: null, production: null }),
  } as never, principal as never, RUN_BOOKING);
  assert.ok(alone);
  assert.equal(alone!.noSubject, true);
  assert.deepEqual(alone!.runs.map((row) => row.run), [RUN_BOOKING]);
  assert.match(ROUND_NO_SUBJECT, /没有绑定同一份来源/);
});

test('collectRoundTree counts same-key runs without an edge as sameKeyUnlinked', async () => {
  const a = runView({ run: RUN_RECOMPOSE, started_at: '2026-11-14T02:00:00.000Z' });
  const b = runView({ run: RUN_R2, started_at: '2026-11-15T02:00:00.000Z' });
  const tree = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => id === RUN_RECOMPOSE
      ? { run: a, latest: null, production: null }
      : id === RUN_R2
        ? { run: b, latest: null, production: null }
        : null,
    listRuns: async () => ({ items: [b, a], next: null }),
    exportSuccessors: async () => ({ run: RUN_RECOMPOSE, successors: [] }),
  } as never, principal as never, RUN_RECOMPOSE);
  assert.ok(tree);
  assert.equal(tree!.runs.length, 1);
  assert.ok(tree!.sameKeyUnlinked >= 1);
  assert.match(ROUND_SAME_KEY_UNLINKED, /没有前后步骤关系/);
});

test('sameKeyUnlinked ignores a newer run that later joins through a middle member', async () => {
  // Enter at R; reverse scan sees V before P is known; V later joins via P. Must not count V as unlinked.
  const recompose = runView({ run: RUN_RECOMPOSE, started_at: '2026-11-14T02:00:00.000Z' });
  const plan = runView({ run: RUN_PLAN, started_at: '2026-11-14T03:00:00.000Z', predecessor: RUN_RECOMPOSE });
  const merge = runView({ run: RUN_MERGE, started_at: '2026-11-14T04:00:00.000Z', predecessor: RUN_PLAN });
  const catalog = new Map([
    [RUN_RECOMPOSE, { run: recompose, latest: null, production: null }],
    [RUN_PLAN, { run: plan, latest: null, production: null }],
    [RUN_MERGE, { run: merge, latest: null, production: null }],
  ]);
  const tree = await collectRoundTree({
    getRun: async (_u: unknown, id: string) => catalog.get(id) ?? null,
    // Newest first: merge before plan. R lists no successors so P is not admitted until its scan row.
    listRuns: async () => ({ items: [merge, plan, recompose], next: null }),
    exportSuccessors: async (_u: unknown, run: string) => ({
      run,
      successors: run === RUN_PLAN
        ? [{ run: RUN_MERGE, pack: merge.pack, started_at: merge.started_at, predecessor: RUN_PLAN, parameters: {}, sources: [] }]
        : [],
    }),
  } as never, principal as never, RUN_RECOMPOSE);
  assert.ok(tree);
  assert.deepEqual(tree!.runs.map((row) => row.run), [RUN_RECOMPOSE, RUN_PLAN, RUN_MERGE]);
  assert.equal(tree!.sameKeyUnlinked, 0);
});

test('mergeMemberItems keeps first projection id and last accepted conclusion', () => {
  const early = itemResult('doc:1', '早', 'pending', { model: true });
  const late = itemResult('doc:1', '晚', 'satisfied');
  const { projections, conclusionsByItem } = mergeMemberItems([
    { items: [planProjection('doc:1', '合成甲', 1, 1, '1001')], result: asValidation(early) },
    { items: [planProjection('doc:1', '合成甲', 2, 1, '1001')], result: asValidation(late) },
  ]);
  assert.equal(projections.length, 1);
  assert.equal(conclusionsByItem.get('doc:1')?.item.label, '晚');
  const { rows, totals } = buildRoundRows({
    projections,
    conclusionsByItem,
    jobs: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(totals.correct, 1);
  assert.equal(totals.unknown, 0);
});

test('loadJobs keeps one copy when the same job is listed under plan and merge runs', async () => {
  const job: ExportedJob = {
    job: 'job_shared',
    verification_run: RUN_MERGE,
    plan_run: RUN_PLAN,
    items: ['doc:1'],
    sha256: sha,
    ended: 'done',
    outcome: 'effective',
    frozen: false,
    result: null,
    device_return: null,
    rows: [{ item: 'doc:1', dynamic_terminal: 'pass' }],
  };
  const loaded = await loadJobs(
    {
      getRun: async () => null,
      exportJobs: async (_u: unknown, run: string) => {
        if (run === RUN_PLAN || run === RUN_MERGE) return { run, jobs: [job] };
        return { run, jobs: [] };
      },
    } as never,
    principal as never,
    [
      runView({ run: RUN_PLAN, started_at: '2026-11-14T03:00:00.000Z' }),
      runView({ run: RUN_MERGE, started_at: '2026-11-14T04:00:00.000Z' }),
    ],
  );
  assert.equal(loaded.jobs.length, 1);
  const { rows, totals } = buildRoundRows({
    projections: [planProjection('doc:1', '合成', 1, 1, '1001')],
    conclusionsByItem: new Map(),
    jobs: loaded.jobs,
  });
  assert.equal(rows[0]!.deviceAttempts, 1);
  assert.equal(totals.batches, 1);
});

test('device job output is not a run source: sourceForRun alone would miss it', async () => {
  // Documents the G.1 shape: device_return digest is absent from run sources/item locations.
  const deviceSha = shaDevice;
  const runSources: SourceBinding[] = subject();
  assert.equal(runSources.some((row) => row.reference === `src:${deviceSha}`), false);
  const job: ExportedJob = {
    job: 'job_device',
    verification_run: RUN_MERGE,
    plan_run: RUN_PLAN,
    items: ['item-1'],
    sha256: sha,
    ended: 'done',
    outcome: 'effective',
    frozen: false,
    result: null,
    device_return: `src:${deviceSha}`,
    rows: [{ item: 'item-1', dynamic_terminal: 'pass' }],
  };
  assert.equal(job.device_return, `src:${deviceSha}`);
  // Round rows still surface the link when jobs name device_return.
  const { rows } = buildRoundRows({
    projections: [planProjection('item-1', '合成设备行', 1, 1, '1001')],
    conclusionsByItem: new Map(),
    jobs: [job],
  });
  assert.equal(rows[0]!.deviceSha, deviceSha);
  assert.equal(rows[0]!.deviceRun, RUN_MERGE);
});

function devicePageContext(opts: {
  run: string;
  sha: string;
  exportJobs: ExportedJob[] | null;
  sourceForRun: { bytes: Buffer } | null;
  source: { bytes: Buffer } | null;
}): PageContext {
  return {
    principal,
    admin: false,
    url: new URL(`https://192.0.2.1/console/rounds/device?run=${opts.run}&sha256=${opts.sha}`),
    chrome: (title: string) => ({
      title,
      active: 'tasks' as const,
      user: { name: 'synthetic', role: '成员', admin: false },
    }),
    userName: async () => 'synthetic',
    deps: {
      runs: {
        exportJobs: async () => (opts.exportJobs === null ? null : { run: opts.run, jobs: opts.exportJobs }),
      },
      records: {
        artifacts: {
          sourceForRun: async () => opts.sourceForRun,
          source: async () => opts.source,
        },
      },
    },
  } as unknown as PageContext;
}

test('roundDevicePage reads job device_return via artifacts.source when sourceForRun is null', async () => {
  const bytes = Buffer.from('合成设备输出正文\n');
  const job: ExportedJob = {
    job: 'job_device',
    verification_run: RUN_MERGE,
    plan_run: RUN_PLAN,
    items: ['item-1'],
    sha256: sha,
    ended: 'done',
    outcome: 'effective',
    frozen: false,
    result: null,
    device_return: `src:${shaDevice}`,
    rows: null,
  };
  // Red before the fallback: sourceForRun null without source → unreadable.
  const before = await roundDevicePage(devicePageContext({
    run: RUN_MERGE,
    sha: shaDevice,
    exportJobs: [job],
    sourceForRun: null,
    source: null,
  }));
  assert.equal(before.status, 200);
  assert.match(before.body.text, new RegExp(ROUND_DEVICE_UNREADABLE));

  const ok = await roundDevicePage(devicePageContext({
    run: RUN_MERGE,
    sha: shaDevice,
    exportJobs: [job],
    sourceForRun: null,
    source: { bytes },
  }));
  assert.equal(ok.status, 200);
  assert.match(ok.body.text, /合成设备输出正文/);
  assert.doesNotMatch(ok.body.text, new RegExp(ROUND_DEVICE_UNREADABLE));

  const forbidden = await roundDevicePage(devicePageContext({
    run: RUN_MERGE,
    sha: shaDevice,
    exportJobs: null,
    sourceForRun: null,
    source: { bytes },
  }));
  assert.equal(forbidden.status, 200);
  assert.match(forbidden.body.text, new RegExp(ROUND_JOBS_FORBIDDEN));

  const foreign = await roundDevicePage(devicePageContext({
    run: RUN_MERGE,
    sha: '2'.repeat(64),
    exportJobs: [job],
    sourceForRun: null,
    source: { bytes },
  }));
  assert.equal(foreign.status, 404);
});
