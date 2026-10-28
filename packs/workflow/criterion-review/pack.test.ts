import {createTestParserRegistry as createDefaultRegistry} from '../../../hub/testing/parsers.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPackDirectory,validatePack,runPublishCheck,refusalsOf} from '../../../hub/runs/api.ts';
import {fileURLToPath} from 'node:url';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {stagePack} from '../case-review/packaging.ts';
test('the generic criterion review package and both decision polarities pass publication',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'criterion-publish-'));t.after(()=>rm(dir,{recursive:true,force:true}));const staged=await stagePack(fileURLToPath(new URL('./',import.meta.url)),join(dir,'staged'));
 const directory=await readPackDirectory(staged);assert.ok(directory.ok,JSON.stringify(directory));
 const valid=await validatePack(directory.pack);assert.ok(valid.ok,JSON.stringify(valid));
 const published=await runPublishCheck({pack:valid.pack,packDir:staged,sandbox:{requireOsIsolation:await osIsolationAvailable()}});assert.deepEqual(refusalsOf(published,valid.pack),[]);assert.equal(published.samples.passed,4);
});
test('review evidence accepts every concrete media type declared by a core parser',async()=>{
 const {readFile}=await import('node:fs/promises'),{createDefaultRegistry}=await import('../../../hub/refs/api.ts');const workflow=JSON.parse(await readFile(new URL('./workflow.json',import.meta.url),'utf8'));const accepts=workflow.inputs.find((slot:any)=>slot.slot==='evidence').accepts.map((media:string)=>media.toLowerCase());
 for(const media of new Set(createDefaultRegistry().list().flatMap(parser=>parser.mediaTypes).filter(media=>!media.includes('*'))))assert.ok(accepts.includes(media.toLowerCase()),media);
});
