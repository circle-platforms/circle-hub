import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DOCUMENT_OUTPUT_KIND, RELATION_KIND } from '../../../contracts/generated/vocabulary.ts';
import { ContributionInput } from '../../../contracts/src/contributions.ts';
import { ProjectionOutput, SlotsFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory, validatePack, runPublishCheck, refusalsOf } from '../../../hub/runs/api.ts';
import { stagePack, manifestProblems } from '../case-review/packaging.ts';
import { slots } from './pack-files.ts';
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
  const parsed=SlotsFile.parse(slots());
  assert.deepEqual(parsed.item.contribution.codes?.map(v=>v.code),DOCUMENT_OUTPUT_KIND);
  assert.deepEqual(slots().item.contribution.data.properties.relation.properties.kind.enum,RELATION_KIND);
});
test('manifest projection is deterministic and refuses malformed input with a correction',()=>{
  const input={inputs:[{slot:'subject',external:null,sha256:'1'.repeat(64),media_type:'application/json',parser:'json@1',model:{items:[{id:'one',title:'one'}]},meta:null}],parameters:{},context:{}};
  const first=project(input as never);assert.ok(ProjectionOutput.safeParse(first).success);
  assert.equal(JSON.stringify(first),JSON.stringify(project(input as never)));
  assert.ok('error' in project({...input,inputs:[]} as never));
});
test('all four kinds reject forged evidence metadata; relation requires exactly two endpoints',()=>{
  const common={root:'1'.repeat(64),path:'/node',statement:'synthetic',source:{reference:`src:${'2'.repeat(64)}`,quote:'synthetic'}};
  for(const kind of DOCUMENT_OUTPUT_KIND){
    const value={...common,kind,...(kind==='relation'?{relation:{kind:'contradicts',other:common.source}}:{})};
    assert.ok(ContributionInput.safeParse(value).success);
    for(const key of ['applicability','provenance','basis_rank','confidence']) assert.equal(ContributionInput.safeParse({...value,[key]:'invented'}).success,false);
  }
  assert.equal(ContributionInput.safeParse({...common,kind:'relation'}).success,false);
  assert.equal(ContributionInput.safeParse({...common,kind:'assertion',relation:{kind:'same_subject',other:common.source}}).success,false);
});
