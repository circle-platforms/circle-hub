import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import type {KnownBuild} from '../../contracts/src/product.ts';
import {createKnowledgeReader,KnowledgeError} from './api.ts';
import {makeWorld,startPostgres,catalogXml,BASE_CATALOG} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
const build=(name:string):KnownBuild=>({name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:'2026-01-02T00:00:00.000Z',released_at:null,sources:{tree:`site:tree:${name}`},root:null});
test('ambiguous case-only build names return candidates without guessing or hiding them as absence',async t=>{
 const w=await makeWorld(postgres);t.after(()=>w.close());
 const names=['Rel_ACME_10_6_1_7','rel_acme_10_6_1_7'];
 for(const name of names){w.external.set(`site:tree:${name}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});assert.equal((await w.knowledge.produceTree({product:w.product,build:build(name)})).ok,true);}
 const reader=createKnowledgeReader(w.knowledge);
 const id='knowledge:index:acme:REL_ACME_10_6_1_7?kind=definition&key=words';
 const answer=await reader.read(id,{principal:w.user,run:null,purpose:'合成大小写核对'});
 assert.equal(answer.ok,false);if(answer.ok)return;
 assert.match(answer.reason,/候选/);for(const name of names)assert.ok(answer.reason.includes(name));
 assert.match(answer.inputError?.fix??'',/原样|完整/);
 const outsider=await reader.read(id,{principal:w.outsider,run:null,purpose:'合成无权核对'});
 assert.equal(outsider.ok,false);if(!outsider.ok)assert.equal(outsider.inputError,undefined);
});
test('an empty declared-complete catalog remains a complete closed world',async t=>{
 const w=await makeWorld(postgres,{pack:{declaration:{producers:[{id:'commands',title:'合成目录',function:{module:'functions/commands.ts'},inputs:{tree:{source:'tree'}}},{id:'note',title:'合成备注',function:{module:'functions/note.ts'},inputs:{tree:{source:'tree'}}}]},functions:{'commands.ts':'export default () => ({entries:[],warnings:[]});','note.ts':`export default () => ({entries:[{kind:'behaviour',path:'/metadata/note',statement:'合成空目录备注',data:{},fragments:[{parser:'xml@1',selector:'x/catalog'}],applicability:null}],warnings:[]});`}}});t.after(()=>w.close());
 const info=build('Rel_ACME_10_6_1_8');w.external.set(String(info.sources.tree),{bytes:new TextEncoder().encode('<catalog/>'),mediaType:'application/xml'});
 const produced=await w.knowledge.produceTree({product:w.product,build:info});assert.equal(produced.ok,true,produced.reason??'');
 const catalog=await w.knowledge.catalog(produced.root!,'catalog@1');assert.ok(catalog);assert.equal(catalog.complete,true);assert.deepEqual(catalog.entries(),[]);
});
test('authorized stale cursor gets a determined remedy while unreadable roots remain neutral',async t=>{
 const w=await makeWorld(postgres,{knowledge:{limits:{pageNodes:1}}});t.after(()=>w.close());
 const info=build('Rel_ACME_10_6_1_9');w.external.set(String(info.sources.tree),{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const produced=await w.knowledge.produceTree({product:w.product,build:info});assert.equal(produced.ok,true,produced.reason??'');
 const query={root:produced.root!,paths:['/'],depth:6,cursor:'invalid-cursor'};
 await assert.rejects(w.knowledge.getNodes(query,w.user),error=>error instanceof KnowledgeError&&error.code==='REFERENCE_UNRESOLVED'&&error.detail.path==='/cursor'&&/首页/.test(error.fix??'')&&/游标.*首页/.test(error.message));
 assert.equal(await w.knowledge.getNodes(query,w.outsider),null);
});
