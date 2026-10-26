import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { makeUnversionedWorld, startPostgres, catalogXml, BASE_CATALOG } from './test-support.ts';
let pg: Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('build differences never import product-wide paths or entries',async t=>{
 const w=await makeUnversionedWorld(pg);t.after(()=>w.close());
 const scope=await w.knowledge.unversionedRoot!('acme');assert.ok(scope);
 const before=(await w.knowledge.rootOfBuild('acme','Synthetic_10_6'))!;
 w.external.set('site:tree:next',{bytes:catalogXml({...BASE_CATALOG,synthetic:[{name:'next',params:[]}]}),mediaType:'application/xml'});
 const after=await w.knowledge.produceTree({product:w.product,build:{...before.build,name:'Synthetic_10_7',base:'Synthetic_10_7',line:'10.7',sources:{tree:'site:tree:next'}}});assert.ok(after.ok,after.reason??'');
 const nodes=await w.knowledge.diffRoots(before.root,after.root!);
 const entries=await w.knowledge.diffEntries(before.root,after.root!,{kinds:['definition','case']});
 assert.ok(nodes);assert.ok(entries);assert.ok(entries.changes.length);
 assert.equal(JSON.stringify([nodes,entries]).includes('/docs'),false);
 assert.equal(JSON.stringify([nodes,entries]).includes('合成用例'),false);
 assert.equal((await w.knowledge.unversionedRoot!('acme'))?.composition,scope.composition);
});
