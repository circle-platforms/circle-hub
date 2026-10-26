import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('persisted catalog selection follows exact paths and preserves shorter signatures needed to detect ambiguity',async t=>{
 const definitions=['alpha','alpha beta','elsewhere'].map(text=>({kind:'definition',path:'/commands/'+text.split(' ').join('/'),statement:'合成命令 '+text,data:{words:text.split(' '),signatures:[{params:[]}]},fragments:[{parser:'xml@1',selector:'x/commands[1]'}],applicability:null}));
 const w=await makeWorld(postgres,{pack:{functions:{'commands.ts':`export default ()=>({entries:${JSON.stringify(definitions)},warnings:[]});`}}});t.after(()=>w.close());
 w.external.set('site:tree:synthetic-selection',{bytes:Buffer.from('<commands/>'),mediaType:'application/xml'});
 const name='Synthetic_zx-u_10_8_1';
 const produced=await w.knowledge.produceTree({product:w.product,build:{name,family:'zx-u',line:'10.8.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:synthetic-selection'}}});
 assert.equal(produced.ok,true,produced.reason??'');
 const selected=await w.knowledge.catalog(produced.root!,'catalog@1',{base:'/commands',lines:['alpha beta','alpha beta','unknown']});
 assert.ok(selected);assert.equal(selected.complete,true);assert.deepEqual(selected.entries().map(entry=>entry.words.join(' ')),['alpha','alpha beta']);
 assert.ok(selected.entries().every(entry=>entry.reference.includes('/commands/alpha')));
});
