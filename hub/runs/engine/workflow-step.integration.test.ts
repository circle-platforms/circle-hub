import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {WorkflowFile, RequirementsFile} from '../../../contracts/src/pack.ts';
import {SubmitResultOutput} from '../../../contracts/src/tools.ts';
import {startPostgres, type TemporaryPostgres} from '../../testing/postgres.ts';
import {openHarness, sandboxSkip, type Harness} from './testing/harness.ts';
import {reviewPack, writePack} from './testing/packs.ts';
import {standardDocument, toyMap} from './testing/mindmap.ts';

const skip = await sandboxSkip();
let pg: TemporaryPostgres | undefined;
before(async () => { if (!skip) pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

async function addVersion(h: Harness, root: string, version: string, mode: 'one' | 'multiple' | 'unmapped', name = '合成阶段甲') {
  const spec = reviewPack({version});
  const workflow = spec.files['workflow.json'], requirements = spec.files['requirements.json'];
  assert.ok(typeof workflow === 'object' && 'json' in workflow);
  assert.ok(typeof requirements === 'object' && 'json' in requirements);
  const declared = WorkflowFile.parse(workflow.json);
  const templates = RequirementsFile.parse(requirements.json);
  spec.files['workflow.json'] = {json: {...declared, steps: [{id:'first',name},{id:'second',name}]}};
  spec.files['requirements.json'] = {json: {...templates, requirements: templates.requirements.map((r,index) => ({
    ...r,
    ...(mode === 'unmapped' && index === 0 ? {} : {step: mode === 'multiple' && index === 0 ? 'second' : 'first'}),
  }))}};
  return h.workflows.add(await writePack(root,spec));
}

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  assert.ok(pg);
  const h = await openHarness(pg);
  const root = await mkdtemp(join(tmpdir(),'circle-hub-step-'));
  t.after(async () => { await h.close(); await rm(root,{recursive:true,force:true}); });
  const map = await h.upload(h.alice,toyMap(standardDocument()));
  return {h,root,map};
}
async function begin(h: Harness, map: string) {
  const reply = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call('synthetic-step'));
  assert.equal(reply.call_result,'ok',JSON.stringify(reply.errors));
  assert.ok(reply.run);
  return reply.run;
}
function input(run: Awaited<ReturnType<typeof begin>>) {
  return {
    run:run.run,model:'scripted-model temperature=0',
    items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),
    cross_item:[{nature:'judgment',statement:'合成覆盖判断',grounds:[],code:'draft_level',rank:'P4'}],
  };
}

test('actual evaluation supplies a uniquely declared step without replacing verified result facts', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.1','one');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,'合成阶段甲');
  assert.ok(reply.result);
  assert.equal(Object.values(reply.result.partitions).flat().length,run.items.length);
  assert.ok(SubmitResultOutput.safeParse({...reply,trace:'b'.repeat(32)}).success);
});

test('actual evaluation across two ids remains neutral even when their declared names are identical', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.2','multiple');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,undefined);
  assert.ok(reply.result);
});

test('an actually checked unmapped requirement keeps the response neutral', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.3','unmapped');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,undefined);
});

test('a newer published declaration does not rename the frozen run and cached reads do not invent an execution scope', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  const first=await addVersion(h,root,'20.0.4','one','合成阶段甲');
  const run=await begin(h,map);
  assert.equal(run.pack_digest,first.pack.digest);
  const newer=await addVersion(h,root,'20.0.5','one','合成阶段乙');
  assert.notEqual(first.pack.digest,newer.pack.digest);
  const submitted=input(run);
  const reply=await h.service.submitResult(h.alice,submitted,h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,'合成阶段甲');
  const repeated=await h.service.submitResult(h.alice,submitted,h.call('synthetic-step'));
  assert.equal(repeated.acceptance,'accepted');
  assert.equal(repeated.record,reply.record);
  assert.equal(repeated.step_name,undefined,'a cached result has no witnessed new checked scope');
});
