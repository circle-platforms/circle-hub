import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { compileMindmap } from '../../packs/apv/methods/mindmap.ts';
import { TaskResult, sha256 } from '../../packages/contracts/src/index.ts';
import { setup, until } from './harness.ts';

const sourceBytes = (title: string) => Buffer.from(JSON.stringify({ title:'root',children:[{ title:'module',children:[{ title }] }] }));
async function upload(h: Awaited<ReturnType<typeof setup>>, title: string): Promise<any> {
  return h.request('/v1/sources',{ scopeId:'scp_lab',fileName:`${title}.json`,contentBase64:sourceBytes(title).toString('base64') });
}
async function claim(h: Awaited<ReturnType<typeof setup>>): Promise<any> {
  return until(async () => await h.request('/v1/workers/claim',{},'lab-east-01') || false);
}

test('worker receipts require independently matching workbook bytes and a stable repeated report', async t => {
  const h = await setup(t); await h.request('/v1/workers/register',{ workerId:'forged-worker' },'lab-east-01');
  const source = await upload(h,'A');
  const task = await h.request('/v1/tasks/submit',{ scopeId:'scp_lab',capabilityPackId:'mindmap-compile',input:{ sourceRevisionId:source.sourceRevisionId },idempotencyKey:'receipt-binding' });
  const work = await claim(h); assert.equal(work.taskId,task.taskId);
  const correct = await compileMindmap(sourceBytes('A'),'A.json'); const wrong = await compileMindmap(sourceBytes('B'),'B.json');
  const report = { fencingToken:work.fencingToken,inputRevisionId:work.inputRevisionId,status:'succeeded',artifactBase64:correct.workbook.toString('base64') };
  await h.reject(`/v1/workers/operations/${work.operationId}/report`,{ ...report,artifactBase64:wrong.workbook.toString('base64') },'ARTIFACT_VERIFICATION_FAILED','lab-east-01');
  assert.equal((await h.db.query('SELECT 1 FROM artifacts')).rowCount,0);
  assert.notEqual((await h.status(task.taskId)).phase,'delivered');
  await h.request(`/v1/workers/operations/${work.operationId}/report`,report,'lab-east-01');
  const duplicate = await h.request(`/v1/workers/operations/${work.operationId}/report`,report,'lab-east-01'); assert.equal(duplicate.deduplicated,true);
  await h.reject(`/v1/workers/operations/${work.operationId}/report`,{ ...report,status:'partial' },'IDEMPOTENCY_MISMATCH','lab-east-01');
  const result = TaskResult.parse(await h.request(`/v1/tasks/${task.taskId}/result`)); assert.equal(result.phase,'delivered');
  assert.equal((await h.db.query('SELECT 1 FROM artifacts')).rowCount,1);
});

test('superseded operation expiry cannot overwrite the current delivered revision', async t => {
  const h = await setup(t); await h.request('/v1/workers/register',{},'lab-east-01');
  const a = await upload(h,'A'); const b = await upload(h,'B');
  const task = await h.request('/v1/tasks/submit',{ scopeId:'scp_lab',capabilityPackId:'mindmap-compile',input:{ sourceRevisionId:a.sourceRevisionId },idempotencyKey:'revision-flight' });
  const old = await claim(h);
  const next = await h.request(`/v1/tasks/${task.taskId}/input`,{ inputRevisionId:task.inputRevisionId,replacement:{ sourceRevisionId:b.sourceRevisionId } });
  const current = await claim(h); assert.equal(current.inputRevisionId,next.inputRevisionId);
  await h.reject(`/v1/workers/operations/${old.operationId}/preflight`,{ fencingToken:old.fencingToken },'INPUT_REVISION_STALE','lab-east-01');
  const compiled = await compileMindmap(sourceBytes('B'),'B.json');
  await h.request(`/v1/workers/operations/${current.operationId}/report`,{ fencingToken:current.fencingToken,inputRevisionId:current.inputRevisionId,
    status:'succeeded',artifactBase64:compiled.workbook.toString('base64') },'lab-east-01');
  await h.db.query("UPDATE leases SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[old.operationId]);
  await until(async () => (await h.db.query('SELECT status FROM operations WHERE operation_id=$1',[old.operationId])).rows[0].status === 'unknown');
  const result = await h.request(`/v1/tasks/${task.taskId}/result`); assert.equal(result.phase,'delivered'); assert.equal(result.inputRevisionId,current.inputRevisionId);
  await h.reject(`/v1/workers/operations/${old.operationId}/report`,{ fencingToken:old.fencingToken,inputRevisionId:old.inputRevisionId,
    status:'succeeded',artifactBase64:compiled.workbook.toString('base64') },'FENCING_STALE','lab-east-01');
});

test('execution preflight rechecks the live user permission and original bytes enforce their hash', async t => {
  const h = await setup(t); await h.request('/v1/workers/register',{},'lab-east-01');
  const source = await upload(h,'A');
  const task = await h.request('/v1/tasks/submit',{ scopeId:'scp_lab',capabilityPackId:'mindmap-compile',input:{ sourceRevisionId:source.sourceRevisionId },idempotencyKey:'permission-flight' });
  const work = await claim(h);
  await h.setRole('prn_alice','viewer');
  await h.reject(`/v1/workers/operations/${work.operationId}/preflight`,{ fencingToken:work.fencingToken },'FORBIDDEN_ACTION','lab-east-01');
  const result = await h.request(`/v1/tasks/${task.taskId}/result`); assert.notEqual(result.phase,'delivered'); assert.deepEqual(result.artifacts,[]);
  await h.setRole('prn_alice','admin');
  await h.reject('/v1/sources',{ scopeId:'scp_lab',fileName:'../../escape.json',contentBase64:sourceBytes('A').toString('base64') },'INVALID_PAYLOAD');
  await h.reject('/v1/sources',{ scopeId:'scp_lab',fileName:'invalid.json',contentBase64:'not-base64!' },'INVALID_PAYLOAD');
  const largeBytes = Buffer.alloc(2*1024*1024,0x41);
  const largeSource = await h.request('/v1/sources',{ scopeId:'scp_lab',fileName:'large-synthetic.json',contentBase64:largeBytes.toString('base64') });
  assert.equal(largeSource.size,largeBytes.length); assert.equal(largeSource.sha256,sha256(largeBytes));
  const fetched = await fetch(`${h.url}/v1/sources/${source.sourceRevisionId}/content`,{ headers:{ authorization:`Bearer ${await h.login()}` } });
  assert.equal(fetched.status,200); assert.equal(sha256(Buffer.from(await fetched.arrayBuffer())),source.sha256);
  await writeFile(`${h.scratch}/objects/${source.sha256.slice(0,2)}/${source.sha256}`,Buffer.from('synthetic corruption'));
  await h.reject(`/v1/sources/${source.sourceRevisionId}/content`,undefined,'SOURCE_HASH_MISMATCH');
});
