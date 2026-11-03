import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import { sandboxSkip } from './testing/harness.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { INDEX } from './store.ts';
import { createRequestService } from '../../requests/api.ts';

const skip = await sandboxSkip();

test('maintenance recreates missing requests for recorded exits without rewriting the result', {skip}, async t => {
  const pg = await startPostgres();
  let closeHarness = async (): Promise<void> => {};
  t.after(async () => { await closeHarness(); await pg.stop(); });
  const h = await openRetryHarness(pg);
  closeHarness = () => h.close();
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const start = await h.service.startRunDetailed(h.alice, {pack:'toy-locate',inputs:{map:{reference:map}}}, h.call());
  const run = start.answer.run!;
  assert.ok(start.production);
  const old = structuredClone(start.production.result);
  const item = old.partitions.delivered[0];
  const requirement = item.requirements[0];
  const due = '2099-01-01T00:00:00.000Z';
  const exit = {action:'request' as const,request_kind:'repair' as const,audience:{user:h.alice.id},due};
  requirement.layers = [{layer:'static',terminal:'unchecked',reason:'missing_input',missing:'合成主要缺失事实',exit,
    gaps:[{reason:'missing_input',missing:'合成独立缺失事实',exit:structuredClone(exit)},
      {reason:'missing_input',missing:'缺受众的旧出口',exit:{action:'request'}} as never]},
    {layer:'dynamic',terminal:'no_verdict',reason:'missing_input',missing:'合成自动重跑事实',exit:{action:'rerun',audience:{hub:true},due}}];
  requirement.status = 'pending';
  delete requirement.unsatisfied_reason;
  const stored = await h.kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:old,
    index:[{key:INDEX.resultRun,value:run.run}]});
  const original = JSON.stringify((await h.kit.store.get(stored.digest))!.body);
  const requests = createRequestService(h.kit);
  await requests.write({run:run.run,kind:'repair',audience:h.alice.id,due,source:'e'.repeat(64),code:'missing_input',
    item:item.item,requirement:requirement.requirement,missing:'合成主要缺失事实',next_action:'处理另一份合成提交'});
  const matching = async () => (await requests.all(run.run)).filter(row =>
    row.source===old.submission && row.item===item.item && row.requirement===requirement.requirement);
  assert.equal((await matching()).length,0);

  await h.service.maintain();
  const created = await matching();
  assert.deepEqual(created.map(row=>row.missing).sort(),['合成主要缺失事实','合成独立缺失事实']);
  for (const row of created) {
    assert.equal(row.kind,'repair');assert.equal(row.audience,h.alice.id);assert.equal(row.due,due);
    assert.ok(row.next_action.trim());assert.equal(row.answered_by,null);
  }
  assert.equal(JSON.stringify((await h.kit.store.get(stored.digest))!.body),original);

  const answer = await h.kit.store.put({kind:'claim',schema:'synthetic-answer@1',provenance:'declared',body:{fact:'合成答复'}});
  await requests.answer(created[0].record,answer.digest);
  await h.service.maintain();
  const again = await matching();
  assert.equal(again.length,2);
  assert.equal(again.find(row=>row.record===created[0].record)?.answered_by,answer.digest);
  assert.equal(JSON.stringify((await h.kit.store.get(stored.digest))!.body),original);
});
