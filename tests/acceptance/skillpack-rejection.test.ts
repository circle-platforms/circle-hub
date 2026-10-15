import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { setup, type Harness } from './harness.ts';
import { sha256,actionDigest,PACK_FLOWS } from '../../packages/contracts/src/index.ts';
async function prepare(t: Parameters<typeof setup>[0]) {
    const h = await setup(t);
    await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"skillpacks.read\",\"skillpacks.submit\",\"skillpacks.run\"]'::jsonb WHERE principal_id='prn_alice'");
    await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
    await writeFile(`${h.scratch}/runtime.json`, JSON.stringify({ circleBin: 'unstarted-circle.ts', circleCommit: '0'.repeat(40), circleVersion: '1.7.0', model: { kind: 'scripted', base_url: 'http://127.0.0.1:1/v1', model: 'unstarted-synthetic', protocol: 'openai', api_key: 'synthetic-only-key' } }));
    h.env.CIRCLE_RUNTIME_CONFIG = `${h.scratch}/runtime.json`;
    await h.stop();
    await h.startServer();
    return h;
}
async function submit(h: Harness, version: string, id = 'approval-fixture') {
    const bytes = Buffer.from(`---\nname: ${id}\ndescription: Synthetic historical decision\n---\nRevision ${version}.`), response = await fetch(`${h.url}/v1/skillpacks`, { method: 'POST', headers: { authorization: `Bearer ${await h.login()}`, 'content-type': 'application/json', 'x-scope-id': 'scp_lab' }, body: JSON.stringify({ manifest: { id, version, title: 'Synthetic historical decision', owner: 'synthetic', tools: [], triggers: ['manual'], inputs: {}, outputs: ['out.json'], model: 'scripted' }, files: [{ path: 'SKILL.md', base64: bytes.toString('base64'), sha256: sha256(bytes) }], trial: { toolCalls: [], outputs: [] } }) }), body = await response.json() as any;
    assert.equal(response.status, 201, JSON.stringify(body));
    const pack=body.data;
    if(version==='1.0.0'){
      // Reconstruct the pre-change-set persisted request to exercise upgrade
      // compatibility. New submissions are covered by the supersession suite.
      const asset=await h.request(`/v1/assets/${pack.assetId}`),approval=(await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0],input={skillPackId:pack.skillPackId,digest:pack.digest,assetId:pack.assetId,assetVersion:pack.assetVersion},action={inputRevisionId:approval.inputRevisionId,name:'assets.publish',target:pack.assetId,targetIdentity:asset.sha256,args:{skillPackId:pack.skillPackId,digest:pack.digest}},binding={targetIdentity:asset.sha256,actionDigest:actionDigest(action)};
      await h.db.query('UPDATE skill_packages SET change_set_id=NULL WHERE skill_pack_id=$1',[pack.skillPackId]);await h.db.query('DELETE FROM change_sets WHERE change_set_id=$1',[pack.changeSetId]);await h.db.query("UPDATE tasks SET input=$2,capability_pack_id='asset-registration',flow_version=$3 WHERE task_id=$1",[pack.approvalTaskId,JSON.stringify(input),PACK_FLOWS['asset-registration']]);await h.db.query('UPDATE input_revisions SET input=$2 WHERE input_revision_id=$1',[approval.inputRevisionId,JSON.stringify(input)]);await h.db.query('UPDATE approvals SET action=$2,target_identity=$3,action_digest=$4 WHERE approval_id=$1',[approval.approvalId,JSON.stringify(action),asset.sha256,binding.actionDigest]);await h.db.query('UPDATE pending_inputs SET binding=$2 WHERE request_id=$1',[approval.approvalId,JSON.stringify(binding)]);pack.changeSetId=null;
    }
    return pack;
}
async function decision(h: Harness, pack: any) { const record = (await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0]; return { path: `/v1/tasks/${pack.approvalTaskId}/approvals/${record.approvalId}`, record, body: { inputRevisionId: record.inputRevisionId, targetIdentity: record.targetIdentity, actionDigest: record.actionDigest, approve: true } }; }
test('Skill rejection: an old pending version can be declined after a newer version is approved without touching the latest revision', async (t) => {
    const h = await prepare(t), old = await submit(h, '1.0.0'), latest = await submit(h, '1.0.1'), pending = await decision(h, old), current = await decision(h, latest);
    assert.equal(old.assetId, latest.assetId);
    await h.request(current.path, current.body, 'bob');
    const before = await h.request(`/v1/assets/${latest.assetId}`);
    await h.reject(pending.path, pending.body, 'APPROVAL_STALE', 'bob');
    assert.equal((await h.status(old.approvalTaskId)).phase, 'waiting-review');
    const declined = await h.request(pending.path, { ...pending.body, approve: false }, 'bob');
    assert.equal(declined.status, 'declined');
    const closed = await h.status(old.approvalTaskId);
    assert.equal(closed.phase, 'delivered');
    assert.deepEqual(closed.pendingInputs.filter((request: any) => request.status === 'open'), []);
    assert.equal(closed.pendingInputs.find((request: any) => request.requestId === pending.record.approvalId).status, 'answered');
    assert.deepEqual(await h.request(`/v1/assets/${latest.assetId}`), before);
    const packs = await h.request('/v1/skillpacks');
    assert.equal(packs.find((pack: any) => pack.skillPackId === old.skillPackId).status, 'declined');
    assert.equal(packs.find((pack: any) => pack.skillPackId === latest.skillPackId).status, 'registered');
    assert.equal((await h.request('/v1/admin/approvals', undefined, 'admin')).filter((entry: any) => entry.approvalId === pending.record.approvalId && entry.status === 'open').length, 0);
    await h.reject(pending.path, { ...pending.body, approve: false }, 'DECISION_CONFLICT', 'bob');
    await h.reject(`/v1/skillpacks/${old.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'declined-old-version' }, 'APPROVAL_REQUIRED');
    // Rejection closes only governance. The newest registration still admits and
    // passes a worker preflight without starting the scripted runtime.
    const run = await h.request(`/v1/skillpacks/${latest.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'latest-after-old-decline' });
    await h.request('/v1/workers/register', {capabilities:['assets.execute']}, 'lab-east-01');
    const claim = await h.request('/v1/workers/claim', {}, 'lab-east-01');
    assert.equal(claim.taskId, run.taskId);
    const checked = await h.request(`/v1/workers/operations/${claim.operationId}/preflight`, { fencingToken: claim.fencingToken }, 'lab-east-01');
    assert.equal(checked.authorization.manifest.version, '1.0.1');
    await h.stop();
    await h.startServer();
    assert.equal((await h.status(old.approvalTaskId)).phase, 'delivered');
    assert.equal((await h.request(`/v1/tasks/${old.approvalTaskId}/approvals`))[0].status, 'declined');
    assert.deepEqual(await h.request(`/v1/assets/${latest.assetId}`), before);
});
test('Skill rejection: retired applicant permissions do not prevent an independently authorized reviewer from closing the frozen request', async (t) => {
    const h = await prepare(t), old = await submit(h, '1.0.0'), latest = await submit(h, '1.0.1'), pending = await decision(h, old), current = await decision(h, latest);
    await h.request(current.path, current.body, 'bob');
    const before = (await h.db.query('SELECT lifecycle,sha256,approved_digest,approved_by FROM asset_versions WHERE asset_id=$1 AND version=$2', [latest.assetId, latest.assetVersion])).rows[0];
    await h.setRole('prn_alice',null);
    const declined = await h.request(pending.path, { ...pending.body, approve: false }, 'bob');
    assert.equal(declined.status, 'declined');
    assert.equal((await h.request(`/v1/tasks/${old.approvalTaskId}/status`, undefined, 'bob')).phase, 'delivered');
    assert.deepEqual((await h.db.query('SELECT lifecycle,sha256,approved_digest,approved_by FROM asset_versions WHERE asset_id=$1 AND version=$2', [latest.assetId, latest.assetVersion])).rows[0], before);
});
test('Skill rejection: scope reviewer permission self decision and original response bindings remain mandatory for old requests', async (t) => {
    const h = await prepare(t), old = await submit(h, '1.0.0');
    await submit(h, '1.0.1');
    const pending = await decision(h, old), reject = { ...pending.body, approve: false };
    await h.reject(pending.path, reject, 'SELF_APPROVAL');
    await h.db.query("UPDATE policies SET grants=grants || '[\"decisions.approve\",\"assets.approve\"]'::jsonb WHERE principal_id=ANY($1::text[])", [['prn_limited', 'prn_outsider']]);
    await h.setRole('prn_limited','admin','scp_hidden');await h.setRole('prn_outsider','admin');
    await h.reject(pending.path, reject, 'FORBIDDEN_SCOPE', 'limited');
    await h.reject(pending.path, reject, 'FORBIDDEN_SCOPE', 'outsider');
    await h.reject(pending.path, { ...reject, actionDigest: '0'.repeat(64) }, 'APPROVAL_STALE', 'bob');
    await h.reject(pending.path, { ...reject, targetIdentity: 'different-target' }, 'APPROVAL_STALE', 'bob');
    await h.reject(pending.path, { ...reject, inputRevisionId: `inrev_${'0'.repeat(32)}` }, 'APPROVAL_STALE', 'bob');
    await h.setRole('prn_bob','member');
    await h.reject(pending.path, reject, 'FORBIDDEN_ACTION', 'bob');
    assert.equal((await h.status(old.approvalTaskId)).phase, 'waiting-review');
    assert.equal((await h.request(`/v1/tasks/${old.approvalTaskId}/approvals`))[0].status, 'open');
});
test('Skill rejection: concurrent reviewers close an obsolete request once and cannot change its newer approved sibling', async (t) => {
    const h = await prepare(t), old = await submit(h, '1.0.0'), latest = await submit(h, '1.0.1'), pending = await decision(h, old), current = await decision(h, latest);
    await h.request(current.path, current.body, 'bob');
    await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
    const outcomes = await Promise.all(['bob', 'admin'].map(async (user) => h.raw(pending.path, { token: await h.login(user), body: { ...pending.body, approve: false } })));
    assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
    assert.equal(outcomes.find(result => result.status === 409)!.body.error.code, 'DECISION_CONFLICT');
    assert.equal((await h.db.query("SELECT 1 FROM decisions WHERE request_id=$1 AND outcome='declined'", [pending.record.approvalId])).rowCount, 1);
    assert.equal((await h.status(old.approvalTaskId)).phase, 'delivered');
    assert.equal((await h.request(`/v1/assets/${latest.assetId}`)).lifecycle, 'approved');
});
