import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openHarness, sandboxSkip } from '../runs/engine/testing/harness.ts';
import { standardDocument, toyMap } from '../runs/engine/testing/mindmap.ts';
import { runPage, type PageContext } from './console/pages.ts';
import { resultPage, resultsPage } from './console/results.ts';
import { productionShareKey } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async()=>{postgres=await startPostgres();}); after(async()=>{await postgres?.stop();});
test('console shared views are marked, administrator views list decisions, and revocation restores the neutral page', {skip}, async t=>{
  const h=await openHarness(postgres);t.after(()=>h.close());
  const source=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:source}}},h.call())).run!;
  const context=(principal: typeof h.bob): PageContext=>({deps:{records:h.kit,runs:h.service} as unknown as ServerDeps,principal,admin:principal.role==='admin',url:new URL('http://127.0.0.1/console/results'),chrome:title=>({title,user:{name:principal.name,role:principal.role,admin:principal.role==='admin'},csrf:null}),userName:async id=>id?(await h.kit.principals.get(id))?.name??id:'—'});
  const bob=context(h.bob);
  const absent=await runPage(bob,'run_'+'1'.repeat(26));
  assert.deepEqual(await runPage(bob,run.run),absent);
  await h.kit.authorizations.share(h.admin,productionShareKey('toy-locate'),{kind:'pack_users',pack:'toy-locate'});
  await h.kit.authorizations.assign(h.admin,h.bob.id,'toy-locate');
  for(const view of [await runPage(bob,run.run),await resultPage(bob,run.run),await resultsPage(bob)]){
    assert.equal(view.status,200);assert.ok(String(view.body).includes('经管理员分享'));
  }
  const admin=await runPage(context(h.admin),run.run);
  assert.ok(String(admin.body).includes('当前分享'));assert.ok(String(admin.body).includes('production:toy-locate'));
  await h.kit.authorizations.unshare(h.admin,productionShareKey('toy-locate'),{kind:'pack_users',pack:'toy-locate'});
  assert.deepEqual(await runPage(bob,run.run),absent);
  assert.equal((await resultPage(bob,run.run)).status,404);
});

test('shared console receipts omit rejected validation explanations and pointers but preserve owner diagnostics', {skip}, async t=>{
  const h=await openHarness(postgres);t.after(()=>h.close());
  const source=await h.upload(h.alice,toyMap(standardDocument()));
  const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{reference:source}}},h.call());
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));const run=started.run!;
  const rejected=await h.service.submitResult(h.alice,{run:run.run,model:'synthetic-review',items:[{item:'synthetic-private-item',handling:'handled',slots:{}}]},h.call());
  assert.equal(rejected.acceptance,'not_accepted');
  const original=(await h.service.getRun(h.alice,run.run))!;
  const errors=original.submissions.at(-1)!.errors;
  assert.ok(errors.some(error=>error.path!==undefined&&error.message.includes('synthetic-private-item')));
  await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
  const context=(principal:typeof h.bob):PageContext=>({deps:{records:h.kit,runs:h.service} as unknown as ServerDeps,principal,admin:principal.role==='admin',url:new URL('http://127.0.0.1/console/runs'),chrome:title=>({title,user:{name:principal.name,role:principal.role,admin:principal.role==='admin'},csrf:null}),userName:async id=>id?(await h.kit.principals.get(id))?.name??id:'—'});
  const shared=await runPage(context(h.bob),run.run);assert.equal(shared.status,200);
  for(const error of errors){assert.ok(!String(shared.body).includes(error.message));if(error.path)assert.ok(!String(shared.body).includes(error.path));}
  for(const user of [h.alice,h.admin]){
    const own=await runPage(context(user),run.run);assert.equal(own.status,200);
    assert.ok(String(own.body).includes('synthetic-private-item 不是本运行的条目'));
  }
  await h.kit.authorizations.unshare(h.admin,run.run,h.bob.id);
  assert.equal((await runPage(context(h.bob),run.run)).status,404);
});
