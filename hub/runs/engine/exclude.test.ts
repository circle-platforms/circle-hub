// W08 R[1]: a whole-submission refusal evaluates only items whose exact values resolved.
// Instrument table reads to prove checks do not execute, not merely that their output is hidden.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { actionsOf } from './store.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

for (const applies of ['item', 'run'] as const) {
  for (const allFail of [false, true]) {
    test(`${applies} artifact checks skip ${allFail ? 'both' : 'one'} boundary-excluded items and charge only genuine repairs`, {skip}, async t => {
      const h = await openHarness(postgres); t.after(() => h.close());
      const spec = reviewPack({findingsData:{type:'object',properties:{valid:{type:'boolean'}},required:['valid'],additionalProperties:false}});
      spec.id = 'toy-exclusion';
      spec.files['requirements.json'] = {json:{schema:'requirements@1',requirements:[{
        key:'plan_shape',name:'计划形状',description:'合成产物核对',target:'item',required:true,done_rule:'bookkeeping',
        accepted_producer:'fact',layers:['static'],checks:['shape'],
        error_handling:[{code:'toy-exclusion.shape_invalid',action:'repair',max_rounds:2}],
      },{key:'level',name:'合成等级',description:'模型给出等级',target:'run',required:true,done_rule:'bookkeeping',accepted_producer:'judgment',layers:['static'],checks:[],error_handling:[]}]}};
      spec.files['checks.json'] = {json:{schema:'checks@1',checks:[{
        id:'shape',function:{module:'functions/shape.ts'},table:'tables/shape.json',applies,
        judges:'artifact_under_verification',tier:'blocking',basis:'合成计划必须带有效标志',
      }]}};
      spec.files['tables/shape.json'] = {json:{marker:'synthetic invocation counter'}};
      spec.files['functions/shape.ts'] = `export default function(input: any) {
        const subject=input.subject;
        const items=Array.isArray(subject.items)?subject.items:[subject];
        return items.map((it: any)=>{
          const missing=it.slots===null;
          const valid=it.slots?.findings?.[0]?.data?.valid===true;
          return {item:it.item??it.id,verdict:valid?'support':'refute',...(valid?{}:{code:'toy-exclusion.shape_invalid'}),
            statement:missing?'槽位数据不是对象':'合成计划标志不合法',grounds:[],tier:'blocking'};
        });
      }`;
      const workflow = await h.workflows.add(await writePack(dirname(h.review.pack.directory),spec));
      h.workflows.assign(h.alice.id,spec.id);
      const doc = standardDocument();
      doc.groups = [{...doc.groups[0],cases:doc.groups[0].cases.slice(0,2)}];
      const map = await h.upload(h.alice,toyMap(doc));
      const started = await h.service.startRun(h.alice,{pack:spec.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call());
      assert.ok(started.run,JSON.stringify(started.errors));
      const run = started.run; assert.equal(run.items.length,2);
      let calls=0;
      const readJson=workflow.readJson.bind(workflow);
      t.mock.method(workflow,'readJson',(path: string)=>{if(path==='tables/shape.json') calls++;return readJson(path);});
      const submit = (badQuotes: boolean, valid: boolean) => h.service.submitResult(h.alice,{
        run:run.run,model:'synthetic-checker',items:run.items.map((it,i)=>({
          item:it.id,handling:'handled',slots:{findings:[{text:'合成发现',code:'literal_issue',rank:'minor',
            location:it.location,quotes:[{reference:it.location,text:badQuotes && (allFail || i===0)?'原文没有这句话':it.label}],data:{valid}}]},
        })),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}],
      },h.call());
      const refused = await submit(true,false);
      assert.equal(refused.acceptance,'not_accepted');
      const excluded = new Set(run.items.filter((_,i)=>allFail||i===0).map(it=>it.id));
      assert.equal(refused.errors.filter(e=>e.code==='QUOTE_MISMATCH').length,excluded.size);
      const notes=refused.errors.filter(e=>e.code==='toy-exclusion.shape_invalid');
      assert.deepEqual(notes.map(e=>e.item),allFail?[]:[run.items[1].id]);
      assert.ok(!refused.errors.some(e=>e.message.includes('槽位数据不是对象')));
      assert.ok(!notes.some(e=>excluded.has(e.item!)));
      assert.equal(calls,allFail?0:1,'no excluded item executes the artifact check');
      // Boundary errors keep their existing findings bookkeeping. Only a genuine check may charge plan_shape.
      const validations=(await actionsOf(h.kit.store,run.run)).filter(action=>action.body.action==='validate');
      assert.equal(validations.length,1);
      assert.deepEqual(validations[0].body.detail.repair,allFail?['findings']:['findings','plan_shape']);
      assert.ok(refused.result?.cross_item.length===0);
      assert.ok(Object.values(refused.result!.partitions).every(rows=>rows.length===0),'an unaccepted submission stores no item conclusions');
      // Correcting the boundary reveals the unchanged genuine-check budget, then a valid plan repairs normally.
      const checked=await submit(false,false);
      assert.equal(checked.acceptance,'accepted');
      assert.ok(checked.errors.filter(e=>e.code==='toy-exclusion.shape_invalid').every(e=>e.rounds_left===(allFail?2:1)));
      const fixed=await submit(false,true);
      assert.equal(fixed.acceptance,'accepted');
      assert.ok(!fixed.errors.some(e=>e.code==='toy-exclusion.shape_invalid'));
    });
  }
}
