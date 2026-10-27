import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {kityminderParser} from './kityminder.ts';
import {originalCore,MIGRATION_TEST} from '../testing/baseline.ts';
import {compactText,largeDocument} from '../../../../tests/fixtures/mindmaps/index.ts';

test(MIGRATION_TEST,async t=>{
 const baseline=await originalCore();t.after(()=>baseline.close());
 const root=fileURLToPath(new URL('../../../../',import.meta.url));
 const paths=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(path=>path.endsWith('.json')&&!path.startsWith('foundation/')&&!path.startsWith('references/'));
 let files=0,documents=0,rejected=0;const covered=new Set<string>();
 const check=(bytes:Uint8Array,name:string)=>{
  let expected;try{expected=baseline.parser.parse(bytes);}catch{rejected++;return;}
  const actual=kityminderParser.parse(bytes);
  assert.equal(JSON.stringify(actual.model),JSON.stringify(expected.model),name+' model bytes');
  assert.equal(JSON.stringify(actual.summary()),JSON.stringify(expected.summary()),name+' summary bytes');
  assert.deepEqual(actual.listSelectors('',{properties:true}),expected.listSelectors('',{properties:true}),name+' selectors');
  documents++;covered.add(name.split('#')[0]);
 };
 for(const path of paths){
  const bytes=await readFile(join(root,path));let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{continue;}files++;check(bytes,path);
  const pending:Array<{value:unknown;pointer:string}>=[{value,pointer:''}];
  while(pending.length){const item=pending.pop()!,v=item.value;
   if(typeof v==='string'){let decoded;try{decoded=JSON.parse(v);}catch{continue;}check(Buffer.from(v),path+'#'+item.pointer);pending.push({value:decoded,pointer:item.pointer+'/decoded'});}
   else if(v&&typeof v==='object'){
    if(!Array.isArray(v)&&Object.hasOwn(v,'root'))check(Buffer.from(JSON.stringify(v)),path+'#'+item.pointer);
    for(const [key,child]of Object.entries(v))pending.push({value:child,pointer:item.pointer+'/'+key});
   }
  }
 }
 check(Buffer.from(compactText(largeDocument())),'generated/largeDocument');
 for(const required of ['hub/refs/fixtures/mindmap.km.json','hub/refs/fixtures/mindmap.double.json','tests/fixtures/mindmaps/review-150.km.json','tests/fixtures/mindmaps/review-150.double.json','tests/fixtures/mindmaps/template.km.json','packs/product/lumen-api/testing/fixtures/lumen-review.km.json','packs/workflow/case-compile/examples/case-mindmap.json','packs/workflow/template-gap/examples/synthetic-gap.km.json'])assert.ok(covered.has(required),required);
 assert.ok(documents>10);assert.ok(covered.delete('generated/largeDocument'));t.diagnostic(JSON.stringify({json_files:files,accepted_documents:documents,covered_files:covered.size,generated_documents:1,rejected_non_documents:rejected}));
});
