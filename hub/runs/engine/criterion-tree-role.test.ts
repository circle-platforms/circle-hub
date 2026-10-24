import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {createEngineContext} from './deps.ts';
import {buildScope,createResolver,resolveCriterionChanges} from './exact.ts';
import {putRun,runById} from './store.ts';
import {newId} from '../../records/api.ts';
import {createRequestService} from '../../requests/api.ts';
import type {TreeReader} from '../../refs/api.ts';

let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function setup(t:any){
 const h=await criterionHarness(pg);t.after(()=>h.close());const initial=await h.start(),original=(await runById(h.kit.store,initial.run))!;
 const root='a'.repeat(64),tree=(path:string)=>`tree:${root}/${path}@${'e'.repeat(64)}`;
 const otherExpected=await h.upload(h.alice,Buffer.from('旧判据；依据；补充原件'),'text/plain');
 const expected=h.expected+'/text@1/l/1',subject=h.subject+'/json@1/p/value',unbound=await h.upload(h.alice,Buffer.from('旧判据；依据'),'text/plain');
 const origins=new Map<string,string[]>([
  ['/expected',[expected]],['/expected-multiple',[expected,otherExpected+'/text@1/l/1']],
  ['/subject',[subject]],['/unbound',[unbound+'/text@1/l/1']],['/missing',[]],
  ['/non-source',['rec:'+'f'.repeat(64)]],['/mixed-record',[expected,'rec:'+'f'.repeat(64)]],
  ['/mixed',[expected,subject]],['/mixed-unbound',[expected,unbound+'/text@1/l/1']],
 ]);
 const reader:TreeReader={read:(actual,path)=>actual===root&&origins.has(path)?{text:'旧判据；依据',readTier:'model_readable',mediaType:'text/plain',grounds:origins.get(path)}:null,readEntry:()=>null};
 h.knowledge.treeReader=()=>reader;
 const run={...original.body,run:newId('run'),root,sources:[...original.body.sources,{reference:otherExpected,role:'expected' as const}]};await putRun(h.kit.store,run,original.created_at);
 const workflow=await h.workflows.byDigest(run.pack_digest);assert.ok(workflow);
 const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
 const scope=await buildScope(ctx,run,workflow,h.alice,'model'),resolver=createResolver(ctx,scope,'model');
 return {h,run,tree,resolver};
}

test('tree criteria and quotes require every original source to be bound as expected',async t=>{
 const {h,tree,resolver}=await setup(t);
 for(const path of ['subject','unbound','missing','mixed','mixed-unbound','non-source','mixed-record'])for(const position of ['criterion','grounds']){
  const rejected=position==='criterion'?{...h.proposal,criterion:tree(path)}:{...h.proposal,criterion:tree('expected'),grounds:[{reference:tree(path),quote:'依据'}]};
  const out=await resolveCriterionChanges(resolver,[{id:'one'}],[rejected,h.proposal]);
  assert.deepEqual(out.errors,[],`${path}/${position}`);assert.deepEqual(out.refused.map(error=>[error.code,error.path]),[['core.criterion.source_role_mismatch','/criterion_changes/0']],`${path}/${position}`);assert.deepEqual(out.accepted.map(row=>row.index),[1],`${path}/${position}`);
 }
});
test('expected-bound tree originals remain eligible without changing ordinary tree role semantics',async t=>{
 const {h,tree,resolver}=await setup(t);
 for(const path of ['expected','expected-multiple']){const out=await resolveCriterionChanges(resolver,[{id:'one'}],[{...h.proposal,criterion:tree(path),grounds:[{reference:tree(path),quote:'依据'}]}]);assert.deepEqual(out.errors,[]);assert.deepEqual(out.refused,[]);assert.equal(out.accepted.length,1);}
 const ordinary=await resolver.resolve(tree('subject'),{grounds:true});assert.ok(ordinary.ok);assert.equal(ordinary.value.role,'expected');
});
test('a non-expected tree declaration is locally refused and creates no judgment request',async t=>{
 const {h,run,tree}=await setup(t);const answer=await h.submit(run.run,[{...h.proposal,criterion:tree('subject')},h.proposal]);
 assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));assert.ok(answer.errors.some(error=>error.code==='core.criterion.source_role_mismatch'&&error.path==='/criterion_changes/0'));
 const requests=(await createRequestService(h.kit).all(run.run)).filter(request=>request.declaration);assert.deepEqual(requests.map(request=>request.declaration),['/criterion_changes/1']);
 const result=(await h.service.getResult(h.alice,run.run))!.result;assert.ok(Object.values(result.partitions).flat().some(row=>row.requirements.some(requirement=>requirement.status!=='satisfied')));
});
