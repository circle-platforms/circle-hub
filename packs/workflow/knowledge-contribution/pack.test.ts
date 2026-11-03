import {packSchema} from '../../../hub/runs/engine/slots.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DOCUMENT_OUTPUT_KIND, RELATION_KIND } from '../../../contracts/generated/vocabulary.ts';
import { ContributionInput } from '../../../contracts/src/contributions.ts';
import { ProjectionOutput, SlotClaim, SlotsFile } from '../../../contracts/src/pack.ts';
import { StartRunInput } from '../../../contracts/src/tools.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import { readPackDirectory, validatePack, runPublishCheck, refusalsOf } from '../../../hub/runs/api.ts';
import { stagePack, manifestProblems } from '../case-review/packaging.ts';
import { slots, VERSION } from './pack-files.ts';
import project from './functions/project.ts';

const directory=fileURLToPath(new URL('./',import.meta.url));
test('publishable pack validates through the real registry and only contains signed files',async t=>{
  assert.deepEqual(await manifestProblems(directory),[]);
  const scratch=await mkdtemp(join(tmpdir(),'hub-contribution-pack-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  await stagePack(directory,scratch);
  const read=await readPackDirectory(scratch);assert.ok(read.ok,JSON.stringify(read));
  if (!read.ok) return;
  const result=await validatePack(read.pack);
  assert.equal(result.ok,true,JSON.stringify(result));
  if(!result.ok)return;
  const publication=await runPublishCheck({pack:result.pack,packDir:scratch});
  assert.deepEqual(refusalsOf(publication, result.pack),[]);
});
test('slot codes and relation names come directly from the generated model vocabulary',()=>{
  assert.equal(readFileSync(new URL('./slots.schema.json',import.meta.url),'utf8'),JSON.stringify(slots(),null,2)+'\n');
  const parsed=SlotsFile.parse(slots());
  assert.deepEqual(parsed.item.contribution.codes?.map(v=>v.code),DOCUMENT_OUTPUT_KIND);
  assert.deepEqual(slots().item.contribution.data.properties.relation.properties.kind.enum,RELATION_KIND);
});
test('published relation quote rules have both polarities and published examples match their contracts',()=>{
  for(const polarity of ['positive','negative']){
    const dir=new URL(`./samples/${polarity}/`,import.meta.url);
    const samples=readdirSync(dir).map(file=>JSON.parse(readFileSync(new URL(file,dir),'utf8')));
    assert.ok(samples.some(sample=>sample.check==='quotes'&&sample.subject.slots.contribution.some((row:{code:string})=>row.code==='relation')),polarity);
  }
  StartRunInput.parse(JSON.parse(readFileSync(new URL('./examples/start-run.json',import.meta.url),'utf8')));
  const submission=Submission.parse(JSON.parse(readFileSync(new URL('./examples/submit-result.json',import.meta.url),'utf8')));
  for(const item of submission.items){if(item.handling!=='handled')continue;for(const row of SlotClaim.array().parse(item.slots?.contribution??[])){const input=ContributionInput.parse({...row.data,kind:row.code,statement:row.text});assert.equal(input.source.reference,`tree:${input.root}${input.path}`);}}
});
test('the contribution example and skill both require a declared target and the returned lock',()=>{
  const start=StartRunInput.parse(JSON.parse(readFileSync(new URL('./examples/start-run.json',import.meta.url),'utf8')));
  assert.ok(start.product&&start.build);
  const skill=readFileSync(new URL('./SKILL.md',import.meta.url),'utf8');
  assert.ok(skill.includes('在 start_run 顶层写已确认的 product'));
  assert.ok(skill.includes('核对回执里的 product、build 和 root'));
  assert.ok(skill.includes('目标或根缺失时记未知'));
  assert.ok(!skill.includes('不要给 start_run 的 product、version、build'));
});
test('manifest projection is deterministic and refuses malformed input with a correction',()=>{
  const input={inputs:[{slot:'subject',external:null,sha256:'1'.repeat(64),media_type:'application/json',parser:'json@1',model:{items:[{id:'one',title:'one'}]},meta:null}],parameters:{},context:{}};
  const first=project(input as never);assert.ok(ProjectionOutput.safeParse(first).success);
  assert.equal(JSON.stringify(first),JSON.stringify(project(input as never)));
  assert.ok('error' in project({...input,inputs:[]} as never));
});
test('all declared kinds reject forged evidence metadata; relation requires exactly two endpoints',()=>{
  const common={root:'1'.repeat(64),path:'/node',statement:'synthetic',source:{reference:`src:${'2'.repeat(64)}`,quote:'synthetic'}};
  for(const kind of DOCUMENT_OUTPUT_KIND){
    const value={...common,kind,...(kind==='relation'?{relation:{kind:'contradicts',other:common.source}}:{}),...(kind==='applicability_claim'?{applicability_claim:{entry:'3'.repeat(64),field:'models',value:['synthetic-model'],section:['synthetic'],evidence:{identity:{source_sha256:'2'.repeat(64),parser:'text@1',path:'l/1',span:{unit:'byte',offset:0,length:9}},text:'synthetic'}}}:{})};
    assert.ok(ContributionInput.safeParse(value).success);
    for(const key of ['applicability','provenance','basis_rank','confidence']) assert.equal(ContributionInput.safeParse({...value,[key]:'invented'}).success,false);
  }
  assert.equal(ContributionInput.safeParse({...common,kind:'relation'}).success,false);
  assert.equal(ContributionInput.safeParse({...common,kind:'assertion',relation:{kind:'same_subject',other:common.source}}).success,false);
});

test('admission codes have one core registry and no pack namespaced duplicate', () => {
  const registry=JSON.parse(readFileSync(new URL('../../../contracts/codes.json',import.meta.url),'utf8'));
  const admission=registry.codes.filter((entry:{code:string})=>entry.code.startsWith('core.contribution.'));
  assert.equal(admission.length,10);for(const entry of admission){assert.equal(entry.interpreter,'contribution');assert.ok(entry.when&&entry.fix);}
  assert.ok(!readdirSync(new URL('./tables/',import.meta.url)).includes('codes.json'));
  assert.equal(JSON.parse(readFileSync(new URL('./pack.json',import.meta.url),'utf8')).version,VERSION);
});

test('slot data stays regex-free while authoritative contribution admission rejects malformed identities',()=>{
 const schema=packSchema(slots().item.contribution.data);assert.ok(schema.ok);if(!schema.ok)return;
 const value={root:'invalid-digest',path:'/node',source:{reference:'invalid-reference',quote:'synthetic'}};
 assert.equal(schema.schema.safeParse(value).success,true);
 assert.equal(ContributionInput.safeParse({...value,kind:'assertion',statement:'synthetic'}).success,false);
});
