import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';
import { actionOfResult, actionsOf, submissionsOf } from './store.ts';

test('same-session submissions reuse the run declaration while raw history and other sessions remain distinct', async t => {
  const skip = await sandboxSkip(); if (skip) return t.skip(skip);
  const postgres = await startPostgres(); const h = await openHarness(postgres);
  try {
    const source = await h.upload(h.alice, toyMap(standardDocument()));
    const draftIdentity = { model_id: 'synthetic-draft', model_family_id: 'synthetic-family-a' };
    const draft = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', model_identity: draftIdentity, inputs: { map: { reference: source } } }, h.call('draft-session'));
    assert.equal(draft.call_result, 'ok', JSON.stringify(draft.errors)); assert.deepEqual(draft.run!.model_identity, draftIdentity);
    const draftInput = { run: draft.run!.run, model: 'draft-display', items: draft.run!.items.map(item => ({ item: item.id, handling: 'handled' as const, slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '合成初评', grounds: [], code: 'draft_level', rank: 'P4' }] };
    const submitted = await h.service.submitResult(h.alice, draftInput, h.call('draft-session')); assert.equal(submitted.acceptance, 'accepted', JSON.stringify(submitted.errors));
    const saved = await submissionsOf(h.kit.store, draft.run!.run); assert.equal(saved.length, 1); assert.deepEqual(saved[0].body, draftInput, 'the inherited declaration is not written into the original submission');
    const result = await h.service.getResult(h.alice, draft.run!.run); assert.ok(result);
    const verifyIdentity = { model_id: 'synthetic-verifier', model_family_id: 'synthetic-family-b' };
    const verification = await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', predecessor: draft.run!.run, model_identity: verifyIdentity, inputs: { draft: { reference: `rec:${result.record}` }, map: { reference: source } } }, h.call('verify-session'));
    assert.equal(verification.call_result, 'ok', JSON.stringify(verification.errors)); const run = verification.run!;
    const input = { run: run.run, model: 'verify-display', items: run.items.map(item => ({ item: item.id, handling: 'handled' as const, slots: { verification: [{ text: '合成复核', code: 'verified', rank: 'minor', location: item.location, grounds: [item.location] }] } })), cross_item: [{ nature: 'judgment', statement: '合成结论', grounds: [], code: 'verdict', rank: 'PASS' }] };
    const same = await h.service.submitResult(h.alice, input, h.call('verify-session')); assert.equal(same.acceptance, 'accepted', JSON.stringify(same.errors));
    const claims = Object.values(same.result!.partitions).flat().flatMap(item => item.requirements.flatMap(req => req.claims));
    assert.ok(claims.some(claim => claim.warrant.producer === 'model' && claim.warrant.id === 'synthetic-verifier' && claim.warrant.independence === 'model_family_declared'));
    const other = await h.service.submitResult(h.alice, input, h.call('other-session')); assert.equal(other.acceptance, 'accepted', JSON.stringify(other.errors));
    const otherClaims = Object.values(other.result!.partitions).flat().flatMap(item => item.requirements.flatMap(req => req.claims));
    assert.ok(otherClaims.some(claim => claim.warrant.producer === 'model' && claim.warrant.independence === 'unknown'));
    const originalSubmissions=await submissionsOf(h.kit.store,run.run);assert.equal(originalSubmissions.length,1,'identical submitted bytes share one immutable record');
    const actions=(await actionsOf(h.kit.store,run.run)).filter(action=>action.body.action==='validate' && typeof action.body.detail.result==='string');
    const firstAction=actions.find(action=>action.body.detail.session==='verify-session'),secondAction=actions.find(action=>action.body.detail.session==='other-session');
    assert.ok(firstAction&&secondAction);assert.notEqual(firstAction.body.detail.result,secondAction.body.detail.result);
    assert.equal((await actionOfResult(h.kit.store,originalSubmissions[0].digest,firstAction.body.detail.result as string))?.body.detail.session,'verify-session');
    assert.equal((await actionOfResult(h.kit.store,originalSubmissions[0].digest,secondAction.body.detail.result as string))?.body.detail.session,'other-session');
    const override = await h.service.submitResult(h.alice, { ...input, notes: 'explicit identity', model_identity: { model_id: 'synthetic-override', model_family_id: 'synthetic-family-c' } }, h.call('other-session'));
    assert.equal(override.acceptance, 'accepted', JSON.stringify(override.errors));
    assert.ok(Object.values(override.result!.partitions).flat().flatMap(item => item.requirements.flatMap(req => req.claims)).some(claim => claim.warrant.producer === 'model' && claim.warrant.id === 'synthetic-override'));
    assert.deepEqual((await h.kit.store.get(saved[0].digest))!.body, draftInput);
    assert.ok(run.items.some(item => item.id === ITEM.c1));
  } finally { await h.close(); await postgres.stop(); }
});
