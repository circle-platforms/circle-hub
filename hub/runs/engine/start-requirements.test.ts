import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
let pg:TemporaryPostgres;let h:Awaited<ReturnType<typeof openRetryHarness>>;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openRetryHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('start rejects invalid static declarations and creates a pack-owner repair request', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const prior=h.review.requirements.find(r=>r.key==='structure')!.checks;
  h.review.requirements.find(r=>r.key==='structure')!.checks=[];
  try{
    const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call());
    assert.equal(answer.call_result,'error');
    assert.ok(answer.errors.some(e=>e.fix?.includes('请求 rec:')));
    const requests=await h.service.listRequests!(h.admin);
    assert.ok(requests.some(r=>r.pack_digest===h.review.pack.digest&&r.audience===h.admin.id));
  }finally{h.review.requirements.find(r=>r.key==='structure')!.checks=prior;}
});
test('knowledge requirements fail before input reads and name selectable complete builds', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  h.review.knowledge={schema:'knowledge@1',requires:[{catalog:'commands@1',complete:true}]};
  const original=h.knowledge.catalog.bind(h.knowledge);
  h.knowledge.catalog=async()=>null;
  const reads=h.external.reads.length;
  try{
    const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call());
    assert.equal(answer.call_result,'error');
    assert.ok(answer.errors.some(e=>e.path==='/build'&&e.fix?.includes('可选构建')),JSON.stringify(answer.errors));
    assert.equal(h.external.reads.length,reads);
  }finally{h.review.knowledge=null;h.knowledge.catalog=original;}
});

test('a model-driven frozen run gets a named successor request when its line root changes', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const start=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call());
  assert.equal(start.call_result,'ok',JSON.stringify(start.errors));
  const run=start.run!;
  const original=h.knowledge.rootOfBuild.bind(h.knowledge);
  const current=(await original('meadow',run.build!))!;
  h.knowledge.rootOfBuild=async()=>({...current,root:'b'.repeat(64)});
  try{
    await h.service.maintain();
    const requests=await h.service.listRequests!(h.alice,run.run);
    assert.ok(requests.some(r=>r.kind==='disposition'&&r.audience===h.alice.id&&r.next_action.includes('predecessor')));
    assert.equal((await h.service.getRun(h.alice,run.run))!.run.root,run.root);
  }finally{h.knowledge.rootOfBuild=original;}
});

test('a new build on the line never implies a change to the run-selected named build root', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call());
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));const run=started.run!;
  const original=h.knowledge.currentRoot.bind(h.knowledge),current=(await original('meadow','10.6.1'))!;
  h.knowledge.currentRoot=async()=>({...current,root:'c'.repeat(64),build:{...current.build,name:'rel_meadow_10_7_1',base:'rel_meadow_10_7_1',line:'10.7'}});
  try{await h.service.maintain();assert.ok(!(await h.service.listRequests!(h.alice,run.run)).some(r=>r.kind==='disposition'));}finally{h.knowledge.currentRoot=original;}
});
