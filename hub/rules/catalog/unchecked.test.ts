import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CatalogEntry,CheckOutcome} from '../../../contracts/src/tables.ts';
import {createCatalogView,getInterpreter} from '../api.ts';
const reference=`tree:${'a'.repeat(64)}/commands/demo`;
const gap={path:'x/commands/item/arguments/arg/@limit',reason:'missing_input',missing:'synthetic constraint meaning',next_action:'由包作者声明格式后重产'};
const run=(signatures:any[],commands:string[],claims?:any[])=>getInterpreter('catalog@1')!.run({interpreter:'catalog@1',table:{schema:'catalog@1',origin:'synthetic constraint contract',catalog:'commands',commands:['$.commands'],...(claims?{claims:{select:'$.claims[*]',command:'/command',present:'/present'}}:{})},subject:{commands,claims},catalog:createCatalogView([{words:['demo'],signatures,reference}],{complete:true,reference}),context:{}});
test('an unchecked constraint is preserved by the strict catalog schema and becomes a top-level missing fact',()=>{
 const signatures=[{params:[{name:'n',type:'int',minimum:0,maximum:20,unchecked_constraints:[gap]}]}];
 assert.equal(CatalogEntry.safeParse({words:['demo'],signatures,reference}).success,true);
 const [outcome]=run(signatures,['demo 7']);assert.equal(outcome.verdict,'unknown');assert.equal(outcome.missing,gap.missing);assert.equal(outcome.exit,undefined);assert.equal(outcome.data?.missing,undefined);CheckOutcome.parse(outcome);
 assert.equal(CatalogEntry.safeParse({words:['demo'],signatures:[{params:[{name:'n',type:'int',unchecked_constraints:[{...gap,missing:' '}]}]}],reference}).success,false);
});
test('known native failures remain refutations and a complete matching overload wins over unchecked alternatives',()=>{
 const uncertain={params:[{name:'n',type:'int',minimum:0,maximum:20,unchecked_constraints:[gap]}]};
 assert.equal(run([uncertain],['demo 21'])[0].verdict,'refute');
 assert.equal(run([uncertain,{params:[{name:'n',type:'int',minimum:7,maximum:7}]}],['demo 7'])[0].verdict,'support');
 assert.equal(run([{params:[{name:'n',type:'int',optional:true,unchecked_constraints:[gap]}]}],['demo'])[0].verdict,'support');
});
test('parameterized existence and nonexistence claims both remain unknown when their constraint is unchecked',()=>{
 const outcomes=run([{params:[{name:'n',type:'int',unchecked_constraints:[gap]}]}],[],[{command:'demo 7',present:true},{command:'demo 7',present:false}]);
 assert.deepEqual(outcomes.map(outcome=>outcome.verdict),['unknown','unknown']);
});
test('R4 an undeclared native type stays unknown and is never silently treated as string',()=>{
 const signatures=[{params:[{name:'peer',type_declaration_status:'undeclared',unchecked_constraints:[{...gap,path:'./arguments/arg/@type',missing:'native type declaration'}]}]}];
 const parsed=CatalogEntry.parse({words:['demo'],signatures,reference});
 assert.equal(parsed.signatures[0].params[0].type,undefined);
 for(const command of ['demo peer.invalid','demo 192.0.2.7','demo arbitrary']){
  const outcome=run(signatures,[command])[0];assert.equal(outcome.verdict,'unknown');assert.equal(outcome.missing,'native type declaration');
 }
 assert.equal(run([...signatures,{params:[{name:'peer',type:'ipv4'}]}],['demo 192.0.2.7'])[0].verdict,'support','a complete declared overload still wins');
});
