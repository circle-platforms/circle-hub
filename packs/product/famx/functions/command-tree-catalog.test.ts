import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CatalogEntry} from '../../../../contracts/src/tables.ts';
import {createCatalogView,getInterpreter} from '../../../../hub/rules/api.ts';
import {produceCommandEntries} from './command-tree.ts';
import type {CommandEntryData} from './types.ts';
import {xml} from '../testing/test-support.ts';
const root='a'.repeat(64);
const tree=(argumentsXml:string)=>xml(`<commands><scope type="global"><menu name="demo"><item name="lookup"><arguments>${argumentsXml}</arguments></item></menu></scope></commands>`);
const data=(result:ReturnType<typeof produceCommandEntries>)=>result.entries[0].data as CommandEntryData;
function check(result:ReturnType<typeof produceCommandEntries>,commands:string[]){
 const entries=result.entries.map(entry=>CatalogEntry.parse({...entry.data,reference:`tree:${root}${entry.path}`}));
 return getInterpreter('catalog@1')!.run({interpreter:'catalog@1',table:{schema:'catalog@1',origin:'synthetic parameter contract',catalog:'commands',commands:['$.commands']},subject:{commands},catalog:createCatalogView(entries,{reference:`tree:${root}/commands`,complete:true}),context:{}});
}
test('explicit hostname types and address roles survive production and enforce the bound catalog',()=>{
 const produced=produceCommandEntries(tree('<arg name="peer" type="HOSTNAME" address_role="peer-endpoint"/><arg name="target" type="IP_OR_HOSTNAME" address_role="target-endpoint"/>'));
 assert.deepEqual(data(produced).signatures[0].params.map(param=>[param.type,param.address_role]),[['hostname','peer-endpoint'],['ip_or_hostname','target-endpoint']]);
 assert.equal(data(produced).signatures[0].params[0].maxLength,undefined);
 assert.deepEqual(check(produced,['demo lookup peer.invalid 192.0.2.7','demo lookup peer.invalid 2001:db8::7','demo lookup peer.invalid target.invalid','demo lookup https://peer.invalid target.invalid','demo lookup peer.invalid https://target.invalid']).map(outcome=>outcome.verdict),['support','support','support','refute','refute']);
});
test('explicit role declarations need the pack schema and origin, may leave the native type unchanged, and never infer a role from a name',()=>{
 const model=tree('<arg name="client" type="DOTTEDIP" address_role="source-endpoint"/><arg name="server" type="DOTTEDIP"/>');
 // A published declaration only overrides the tree when it carries the exact schema and the origin this pack authorizes;
 // anything else is ignored with a warning and the tree's own field stands (no silent precedence).
 const authorized={schema:'famx-command-argument-types@1',origin:'product:famx/README.md#command-grammar'};
 const produced=produceCommandEntries(model,{argumentTypes:[
  {...authorized,command:'demo lookup',position:1,address_role:'target-endpoint'},
  {...authorized,command:'demo lookup',position:2,address_role:'ignored-endpoint',origin:'synthetic published role declaration'},
 ] as never});
 assert.equal(data(produced).signatures[0].params[0].type,'ipv4');
 assert.equal(data(produced).signatures[0].params[0].address_role,'target-endpoint');
 assert.equal(data(produced).signatures[0].params[1].address_role,undefined);
 assert.ok(produced.warnings.some(warning=>warning.includes('origin')),JSON.stringify(produced.warnings));
});
test('the help string is kept as a description and never changes a declared type',()=>{
 // famx README (命令语法): 类型只按原始 `type` 精确字段和本包的 ARGUMENT_TYPES 定义；help 只保留说明，不能改变类型。
 const v4=produceCommandEntries(tree('<arg type="DOTTEDIP" help_string="IPv4 address or hostname"/>'));
 assert.deepEqual(data(v4).signatures.map(signature=>signature.params[0].type),['ipv4']);
 assert.equal(data(v4).signatures[0].params[0].description,'IPv4 address or hostname');
 assert.deepEqual(check(v4,['demo lookup 192.0.2.8','demo lookup peer.invalid','demo lookup 2001:db8::8']).map(outcome=>outcome.verdict),['support','refute','refute']);
 // A union type expands into exactly its declared alternatives, each overload consuming every parameter.
 const either=produceCommandEntries(tree('<arg type="IPADDR" help_string="IP address or hostname"/>'));
 assert.deepEqual(data(either).signatures.map(signature=>signature.params[0].type),['ipv4','ipv6']);
 const mask=produceCommandEntries(tree('<arg type="IPMASK"/>'));
 assert.deepEqual(data(mask).signatures.map(signature=>[signature.params[0].type,signature.params[0].maximum??null]),[['mask',null],['int',128]]);
 const host=produceCommandEntries(tree('<arg type="HOSTNAME" help_string="Hostname of the peer"/>'));
 assert.equal(data(host).signatures[0].params[0].type,'hostname');
 const union=produceCommandEntries(tree('<arg type="IP_OR_HOSTNAME" help_string="IP or hostname or URL"/>'));
 assert.equal(data(union).signatures[0].params[0].type,'ip_or_hostname');
 // An unknown type stays undeclared with its recovery instead of falling back to a guessed string.
 const unknown=produceCommandEntries(tree('<arg type="WIDGET" help_string="Anything"/>'));
 assert.equal(data(unknown).signatures[0].params[0].type,undefined);
 assert.equal(data(unknown).signatures[0].params[0].type_declaration_status,'undeclared');
});

test('only inclusive bracket ranges become constraints; every other nonempty spelling stays unchecked',()=>{
 const range=produceCommandEntries(tree('<arg name="count" type="U16" limit="[4 - 9]"/>'));
 assert.deepEqual([data(range).signatures[0].params[0].minimum,data(range).signatures[0].params[0].maximum],[4,9]);
 assert.deepEqual(check(range,['demo lookup 4','demo lookup 9','demo lookup 3','demo lookup 10']).map(outcome=>outcome.verdict),['support','support','refute','refute']);
 for(const spelling of ['7','single','{on|off}','1,2','1~9','[9 - 4]']){
  const produced=produceCommandEntries(tree(`<arg name="count" type="U16" limit="${spelling}"/>`));
  const param=data(produced).signatures[0].params[0] as any;
  assert.deepEqual([param.minimum,param.maximum],[0,65535]);assert.equal(param.values,undefined);
  assert.equal(param.unchecked_constraints.length,1);const gap=param.unchecked_constraints[0];
  assert.equal(gap.missing,'这种 limit 写法的含义');assert.match(gap.path,/\/arguments\/arg\/@limit$/);assert.match(gap.next_action,/包作者.*README.*重产/);
  const outcomes=check(produced,['demo lookup 4','demo lookup 9']);
  for(const outcome of outcomes){assert.equal(outcome.verdict,'unknown');assert.equal(outcome.missing,'这种 limit 写法的含义');assert.equal(outcome.exit,undefined);assert.equal(outcome.data?.missing,undefined);}
  assert.ok(produced.warnings.some(warning=>warning.includes(gap.path)&&warning.includes('limit 写法不认识')));
 }
 for(const spelling of ['40','[1 - 40]','word']){
  const produced=produceCommandEntries(tree(`<arg type="STRING" length="${spelling}"/>`));const param=data(produced).signatures[0].params[0] as any;
  assert.equal(param.minLength,undefined);assert.equal(param.maxLength,undefined);assert.match(param.unchecked_constraints[0].path,/@length$/);
  assert.equal(check(produced,['demo lookup arbitrary'])[0].verdict,'unknown');
 }
 const blank=produceCommandEntries(tree('<arg type="STRING" limit="  " length=""/>'));assert.equal((data(blank).signatures[0].params[0] as any).unchecked_constraints,undefined);
 assert.equal(check(blank,['demo lookup arbitrary'])[0].verdict,'support');
});
