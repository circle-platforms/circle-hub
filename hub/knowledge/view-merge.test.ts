import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {makeUnversionedWorld,startPostgres} from './test-support.ts';
import {createKnowledge,createKnowledgeReader} from './api.ts';

import {completeKnowledgeView} from './complete-view.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
for(const type of ['index','facets','impact'])test(`${type} collates bounded pages from the frozen unversioned composition`,async t=>{
 const w=await makeUnversionedWorld(pg,false,{entries:5,statementBytes:1600});t.after(()=>w.close());
 const knowledge=createKnowledge({records:w.kit,parsers:createDefaultRegistry(),packs:w.packs,external:w.external,admin:w.admin,limits:{maxViewBytes:65536+2600}});
 const build=(await knowledge.rootOfBuild('acme','Synthetic_10_6'))!,scope=(await knowledge.unversionedRoot!('acme'))!;
 const context={principal:w.admin,run:'run_0123456789abcdefghjkmnpqrs',purpose:'synthetic merged view',build:build.build.name,composition:build.composition,unversioned:{root:scope.root,composition:scope.composition}};
 const base=type==='impact'?'Synthetic_10_6..Synthetic_10_6':build.build.name;
 const query=type==='index'?'kind=case&key=document':type==='facets'?'kind=case&by=module':'changed=definition&attached=case';
 const id=`knowledge:${type}:acme:${base}?${query}`,reader=createKnowledgeReader(knowledge);
 let pages=0;
 const external={accepts:reader.accepts,read:async(uri:string,ctx:typeof context)=>{pages++;const result=await reader.read(uri,ctx);if(pages===1){w.external.set('site:tree:scope',{bytes:'<catalog changed="yes"/>',mediaType:'application/xml'});await w.knowledge.syncProduct(w.product,{recheck:true});}return result;}};
 const bound=await completeKnowledgeView(id,context,external,w.kit);assert.ok(bound.ok,JSON.stringify(bound));
 const source=await w.kit.artifacts.source(w.admin,bound.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
 const view=JSON.parse(Buffer.from(source.bytes).toString());assert.equal(view.unversioned.composition,scope.composition);assert.equal(view.unversioned.totals.entries,5);assert.equal(view.truncated,false);assert.equal(view.next,null);
 if(type==='facets'){assert.equal(view.rows.length,5);assert.equal(view.total,5);}else{assert.equal(Object.keys(view.entries).length,5);assert.ok(Object.values(view.entries).every((entry:any)=>entry.root===scope.root&&entry.build===null));assert.ok(pages>1);}
 assert.ok(view.scope.additional_roots.some((root:any)=>root.composition===scope.composition&&root.build===null));
});
