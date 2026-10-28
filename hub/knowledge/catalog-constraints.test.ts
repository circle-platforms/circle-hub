import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createHash} from 'node:crypto';
import {ProducerOutput} from '../../contracts/src/product.ts';
import {CheckOutcome} from '../../contracts/src/tables.ts';
import {getInterpreter} from '../rules/api.ts';
import {commandTreeProducer} from '../../packs/product/famx/api.ts';
import {xmlParser} from '../testing/parsers.ts';
import {makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('knowledge production and catalog reading retain an unchecked source constraint',async t=>{
 const bytes=Buffer.from('<commands><scope type="global"><item name="demo"><arguments><arg type="U16" limit="7" address_role="peer-endpoint"/></arguments></item></scope></commands>');
 // Exercise the declared Hub boundary: the parser's declarations map is pack-internal provenance.
 const produced=commandTreeProducer({slots:{tree:{parser:'xml@1',media_type:'application/xml',sha256:createHash('sha256').update(bytes).digest('hex'),model:xmlParser.parse(bytes).model}}});
 ProducerOutput.parse(produced);
 assert.equal(Object.hasOwn(produced,'declarations'),false);
 const w=await makeWorld(postgres,{pack:{functions:{'commands.ts':`export default ()=>(${JSON.stringify(produced)});`}}});t.after(()=>w.close());
 w.external.set('site:tree:synthetic',{bytes,mediaType:'application/xml'});const name='Rel_ACME_10_8_1_71';
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.8.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:synthetic'}}});assert.equal(result.ok,true,result.reason??'');
 const catalog=await w.knowledge.catalog(result.root!,'catalog@1');assert.ok(catalog);assert.equal(catalog.get(['demo'])!.signatures[0].params[0].unchecked_constraints?.[0].missing,'这种 limit 写法的含义');
 const [outcome]=getInterpreter('catalog@1')!.run({interpreter:'catalog@1',table:{schema:'catalog@1',origin:'synthetic constraint preservation',catalog:'commands',commands:['$.commands']},subject:{commands:['demo 8']},context:{},catalog});
 assert.equal(outcome.verdict,'unknown');assert.equal(outcome.missing,'这种 limit 写法的含义');assert.equal(outcome.exit,undefined);CheckOutcome.parse(outcome);
});

test('catalog impact ignores unchecked constraint locators and recovery wording while retaining raw source changes',async()=>{
 const {catalogCanon}=await import('./produce.ts');
 const entry={words:['demo'],signatures:[{params:[{name:'n',type:'int',unchecked_constraints:[{path:'x/item[1]/arg/@limit',reason:'missing_input',missing:'synthetic meaning',next_action:'synthetic action',source_value:'7'}]}]}]};
 const moved=structuredClone(entry);moved.signatures[0].params[0].unchecked_constraints[0].path='x/item[2]/arg/@limit';moved.signatures[0].params[0].unchecked_constraints[0].next_action='another synthetic action';
 assert.equal(catalogCanon(entry),catalogCanon(moved));moved.signatures[0].params[0].unchecked_constraints[0].source_value='8';assert.notEqual(catalogCanon(entry),catalogCanon(moved));
});

test('R4 unknown native types survive the tree and grammar evidence prevents a complete-catalog claim',async t=>{
 const bytes=Buffer.from('<commands><item name="demo"><arguments><arg name="peer"/></arguments></item></commands>');
 // Exercise the declared Hub boundary: the parser's declarations map is pack-internal provenance.
 const produced=commandTreeProducer({slots:{tree:{parser:'xml@1',media_type:'application/xml',sha256:createHash('sha256').update(bytes).digest('hex'),model:xmlParser.parse(bytes).model}}});
 ProducerOutput.parse(produced);
 assert.equal(Object.hasOwn(produced,'declarations'),false);
 const w=await makeWorld(postgres,{pack:{functions:{'commands.ts':`export default ()=>(${JSON.stringify(produced)});`}}});t.after(()=>w.close());
 w.external.set('site:tree:synthetic',{bytes,mediaType:'application/xml'});const name='Rel_ACME_10_8_9_71';
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.8.9',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:synthetic'}}});assert.equal(result.ok,true,result.reason??'');
 const catalog=await w.knowledge.catalog(result.root!,'catalog@1');assert.ok(catalog);assert.equal(catalog.complete,false);
 const param=catalog.get(['demo'])!.signatures[0].params[0];assert.equal(param.type,undefined);assert.equal(param.type_declaration_status,'undeclared');
 const [outcome]=getInterpreter('catalog@1')!.run({interpreter:'catalog@1',table:{schema:'catalog@1',origin:'synthetic R4 native type evidence',catalog:'commands',commands:['$.commands']},subject:{commands:['demo arbitrary']},context:{},catalog});
 assert.equal(outcome.verdict,'unknown');assert.match(outcome.missing??'',/类型/);CheckOutcome.parse(outcome);
});
