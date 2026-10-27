import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { artifactShareKey } from '../../../hub/records/constants.ts';
import { fixtureBytes } from '../../../tests/fixtures/mindmaps/index.ts';
import { ALIAS, LINE } from '../../product/famx/testing/site.ts';
import { openReviewBed, type ReviewBed } from './testing/bed.ts';

let postgres: TemporaryPostgres;
let bed: ReviewBed;

before(async () => {
  postgres = await startPostgres();
  bed = await openReviewBed(postgres);
});

after(async () => {
  await bed?.close();
  await postgres?.stop();
});

const DRAFT_SOURCES = { stories: ['31057'], bugs: ['31057'] };
const DRAFT_IDENTITY = { model_id: 'synthetic-draft', model_family_id: 'synthetic-family-alpha' };
const VERIFIER_IDENTITY = { model_id: 'synthetic-verifier', model_family_id: 'synthetic-family-omega' };

function neutralShape(answer: { call_result: string; run?: unknown; errors: unknown }) {
  return { call_result: answer.call_result, run: answer.run, errors: answer.errors };
}

test('a shared draft and original admit another assigned reviewer, while absent and revoked shares stay neutral', async () => {
  const target = await bed.upload(bed.reviewer, fixtureBytes('review-150.km.json'), 'review-150.km.json');
  const draft = await bed.service.startRun(bed.reviewer, {
    pack: 'case-review', product: 'FAMX', version: LINE,
    inputs: { subject: { reference: target } }, parameters: DRAFT_SOURCES,
  }, bed.call('sess-predecessor-draft'));
  assert.equal(draft.call_result, 'ok', JSON.stringify(draft.errors));
  assert.ok(draft.run);
  assert.ok(draft.run.items.length > 0);
  const draftSubmission = await bed.service.submitResult(bed.reviewer, {
    run: draft.run.run, model: 'synthetic-draft', model_identity: DRAFT_IDENTITY,
    items: draft.run.items.map(item => ({
      item: item.id, handling: 'handled',
      slots: {
        findings: [],
        ...(draft.run!.requirements.some(requirement => requirement.key === 'expected_quality') ? { expected_quality: [] } : {}),
      },
    })),
    cross_item: [{ nature: 'judgment', statement: '合成初评等级', grounds: [], code: 'level', rank: 'P4' }],
  }, bed.call('sess-predecessor-draft'));
  assert.equal(draftSubmission.acceptance, 'accepted', JSON.stringify(draftSubmission.errors));
  const draftResult = await bed.service.getResult(bed.reviewer, draft.run.run);
  assert.ok(draftResult);

  const other = await bed.kit.principals.createUser(bed.admin, '合成共享复核人');
  await bed.registry.assign(bed.admin, other.id, 'case-review-verify');
  const startVerification = () => bed.service.startRun(other, {
    pack: 'case-review-verify', product: 'FAMX', version: LINE, build: ALIAS,
    inputs: { target: { reference: target }, draft: { reference: `rec:${draftResult.record}` } },
    parameters: DRAFT_SOURCES, predecessor: draft.run!.run,
  }, bed.call('sess-other-verifier'));

  const unshared = await startVerification();
  assert.equal(unshared.call_result, 'error');
  assert.ok(unshared.errors.some(error => error.code === 'SOURCE_UNAVAILABLE' && error.path === '/predecessor'));
  const before = neutralShape(unshared);

  await bed.kit.authorizations.share(bed.admin, draft.run.run, [other.id], '合成分享初评运行');
  const withoutOriginal = await startVerification();
  assert.equal(withoutOriginal.call_result, 'error');
  assert.ok(withoutOriginal.errors.some(error => error.code === 'SOURCE_UNAVAILABLE'));

  const originals = await bed.kit.artifacts.records(target.slice(4));
  const original = originals.find(row => row.body.name === 'review-150.km.json' && row.body.author.user === bed.reviewer.id);
  assert.ok(original);
  await bed.kit.authorizations.share(bed.admin, artifactShareKey(original), [other.id], '合成分享初评脑图原件');
  const started = await startVerification();
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  assert.ok(started.run);
  assert.equal(started.run.predecessor, draft.run.run);
  const stored = await bed.service.getRun(other, started.run.run);
  assert.equal(stored?.run.predecessor_access, 'view');
  assert.ok(started.run.items.length > 0);

  const submission = await bed.service.submitResult(other, {
    run: started.run.run, model: 'synthetic-verifier', model_identity: VERIFIER_IDENTITY,
    items: started.run.items.map(item => ({ item: item.id, handling: 'handled', slots: { verification: [] } })),
    cross_item: [{
      nature: 'judgment', statement: '合成独立复核通过',
      grounds: [started.run!.items[0]!.location], code: 'PASS', rank: 'P4',
    }],
  }, bed.call('sess-other-verifier'));
  assert.equal(submission.acceptance, 'accepted', JSON.stringify(submission.errors));
  assert.ok(submission.result?.cross_item.some(claim =>
    claim.requirement === 'final' && claim.warrant.independence === 'model_family_declared'));

  await bed.kit.authorizations.unshare(bed.admin, draft.run.run, other.id, '合成撤回初评分享');
  const revoked = await startVerification();
  assert.deepEqual(neutralShape(revoked), before);
});
