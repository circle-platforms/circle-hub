import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoundRows,
  caseIdentity,
  isCompileWorkflowPack,
  judgmentOfConclusion,
  packNameOf,
  sameRoundKeys,
  subjectReference,
  ROUND_NO_CONCLUSION,
} from './round-view.ts';
import { itemConclusion } from '../text.ts';
import type { ItemProjection } from '../../../contracts/src/run.ts';
import type { ItemResult } from '../../../contracts/src/validation.ts';
import type { ExportedJob } from '../../ports.ts';

const sha = 'a'.repeat(64);
const src = `src:${sha}`;

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

test('compile pack names recognise case-compile and recompose family', () => {
  assert.equal(packNameOf('case-compile@3.20.2'), 'case-compile');
  assert.equal(isCompileWorkflowPack('case-compile@3.20.2'), true);
  assert.equal(isCompileWorkflowPack('recompose@1.2.5'), true);
  assert.equal(isCompileWorkflowPack('recompose-authority@1.1.10'), true);
  assert.equal(isCompileWorkflowPack('case-review@1.0.0'), false);
});

test('sameRoundKeys require subject src and product/version/build', () => {
  const anchor = {
    product: 'apv',
    version: '1',
    build: 'Beta.1',
    pack: 'case-compile@3.20.2',
    sources: [{ role: 'subject' as const, reference: src, slot: 'subject' }],
  };
  assert.equal(sameRoundKeys(anchor, { ...anchor, pack: 'recompose@1.2.5' }), true);
  assert.equal(sameRoundKeys(anchor, { ...anchor, build: 'Beta.2' }), false);
  assert.equal(sameRoundKeys(anchor, { ...anchor, sources: [{ role: 'subject' as const, reference: `src:${'b'.repeat(64)}`, slot: 'subject' }] }), false);
  assert.equal(subjectReference(anchor.sources), src);
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
    verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
    plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbbbb',
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
  assert.equal(totals.batches, 1);
  assert.equal(judgmentOfConclusion(ROUND_NO_CONCLUSION), null);
});

test('missing Hub conclusion stays the empty sentence', () => {
  const one = projection('item-9', '9009');
  const { rows, totals } = buildRoundRows({ projections: [one], conclusionsByItem: new Map(), jobs: [] });
  assert.equal(rows[0]!.conclusion, ROUND_NO_CONCLUSION);
  assert.equal(totals.unknown, 1);
  assert.equal(rows[0]!.deviceAttempts, 0);
});
