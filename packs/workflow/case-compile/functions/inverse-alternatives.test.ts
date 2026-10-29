// Inverse alternatives (the inverse-alternatives task): a switch command whose enum alternatives the product declared
// as an inverse pair cleans up with the paired value of the same signature; undeclared pairs still refuse; the no-prefix
// rules keep working beside them. Synthetic commands and values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown } from './checks.ts';
import { fixture, cleanup } from '../testing/inverse-alternatives.ts';

const policyWithoutPairs = { schema: 'command-policy@1' as const, read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/demo/pool', inverse_prefix: '/commands/no/demo/pool', leading_parameters: 1 }] };

test('a declared enum pair inverts within the same signature: demo feature on cleans up with off', () => {
  const value = fixture(['demo feature on', cleanup('demo feature off')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.every(row => row.verdict === 'support'), JSON.stringify(result));
  const reversed = fixture(['demo feature off', cleanup('demo feature on')]);
  assert.ok(checkCommandsKnown(reversed).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(reversed)));
});

test('a cleanup that repeats the same value instead of the paired alternative is refused', () => {
  const value = fixture(['demo feature on', cleanup('demo feature on')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.some(row => row.verdict === 'refute' && row.statement.includes('缺同设备、逆序的清理操作')), JSON.stringify(result));
});

test('an enum pair the product did not declare still refuses: demo mode auto has no declared inverse', () => {
  const value = fixture(['demo mode auto', cleanup('demo mode manual')], policyWithoutPairs);
  const result = checkCommandsKnown(value);
  assert.ok(result.some(row => row.verdict !== 'support'), JSON.stringify(result));
});

test('declared sibling leaf paths invert by last segment: demo switch on cleans up with demo switch off', () => {
  const value = fixture(['demo switch on', cleanup('demo switch off')]);
  assert.ok(checkCommandsKnown(value).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(value)));
  const reversed = fixture(['demo relay disable', cleanup('demo relay enable')]);
  assert.ok(checkCommandsKnown(reversed).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(reversed)));
});

test('sibling leaves whose pair is not declared still refuse: demo lamp bright has no declared inverse', () => {
  const value = fixture(['demo lamp bright', cleanup('demo lamp dim')], policyWithoutPairs);
  assert.ok(checkCommandsKnown(value).some(row => row.verdict !== 'support'), JSON.stringify(checkCommandsKnown(value)));
});

test('same-signature enum inverses do not require a sibling leaf path', () => {
  // /commands/demo/feature is the same-signature form; nothing declares /commands/demo/feature-on leaves.
  const value = fixture(['demo feature on', cleanup('demo feature off')]);
  assert.ok(checkCommandsKnown(value).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(value)));
});

test('the no-prefix rules keep working beside the alternatives: demo pool add cleans up with no demo pool add', () => {
  const value = fixture(['demo pool add one 10', 'demo feature on', cleanup('demo feature off'), cleanup('no demo pool add one')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.every(row => row.verdict === 'support'), JSON.stringify(result));
});

import {commandObligations} from './command-obligations.ts';
import {readCommandPolicy} from './command-policy.ts';
import type {PlanSlots} from './slots.ts';
import type {CommandDefinition} from './generated/command-grammar.ts';
import type {CommandPolicy} from './command-policy.ts';
type TestCatalog={root:string;entries:Array<{words:string[];reference:string;signatures:Array<CommandDefinition['signatures'][number]>}>;policy:CommandPolicy};
const catalogOf=(value:ReturnType<typeof fixture>)=>value.subject.command_catalog as TestCatalog;
const obligations=(value:ReturnType<typeof fixture>)=>{
 const slots=value.subject.data as PlanSlots;
 const operations=slots.steps.map((step,index)=>({line:String(step.args[0]),pointer:'/steps/'+index,object:step.object,cleanup:step.cleanup===true}));
 return commandObligations(operations,slots,value.subject.command_catalog,[]);
};
test('an enum at another signature or position cannot make a text label invertible',()=>{
 const value=fixture(['demo feature on auto',cleanup('demo feature off auto')]);
 const entry=catalogOf(value).entries.find(entry=>entry.words.join(' ')==='demo feature')!;
 const base=structuredClone(entry.signatures[0].params[0]);
 entry.signatures=[{...entry.signatures[0],params:[{...base,name:'label',type:'string',values:undefined,native_type:{...base.native_type!,name:'STRING'}},{...base,name:'mode',values:['auto','manual']}]},{...entry.signatures[0],id:'other',reference:entry.signatures[0].reference+'/other',params:[{...base},{...base,name:'extra',type:'int',values:undefined},{...base,name:'tail',type:'int',values:undefined}]}] as typeof entry.signatures;
 assert.ok(obligations(value).some(gap=>gap.verdict==='unknown'),'another overload cannot authorize swapping the text label');
});
test('conflicting alternative pairs do not choose the first declaration',()=>{
 assert.equal(readCommandPolicy({...policyWithoutPairs,inverse_alternatives:[['on','off'],['on','auto']]}),null);
});
test('quoted enum values are checked through their parsed values and the same signature',()=>{
 const value=fixture(['demo feature "on"',cleanup('demo feature "off"')]);
 assert.deepEqual(obligations(value),[]);
});
test('two invertible positions remain ambiguous even when a prefix inverse exists',()=>{
 const value=fixture(['demo feature on on',cleanup('no demo feature on on')]);
 const entry=catalogOf(value).entries.find(entry=>entry.words.join(' ')==='demo feature')!;
 entry.signatures[0].params.push({...structuredClone(entry.signatures[0].params[0]),name:'second'});
 catalogOf(value).entries.push({...structuredClone(entry),words:['no','demo','feature'],reference:'tree:'+catalogOf(value).root+'/commands/no/demo/feature'});
 catalogOf(value).policy.inverse_rules.push({source_prefix:'/commands/demo/feature',inverse_prefix:'/commands/no/demo/feature',leading_parameters:2});
 assert.ok(obligations(value).some(gap=>gap.verdict==='unknown'),'ambiguous alternative inversion cannot fall through to another rule');
});

test('other parameters keep their parsed values while their valid quote spelling may differ',()=>{
 const value=fixture(['demo feature pool on',cleanup('demo feature "pool" "off"')]);
 const entry=catalogOf(value).entries.find(entry=>entry.words.join(' ')==='demo feature')!;
 const state=structuredClone(entry.signatures[0].params[0]);
 entry.signatures[0].params=[{...state,name:'label',type:'string',values:undefined,native_type:{...state.native_type!,name:'STRING'}},state];
 assert.deepEqual(obligations(value),[]);
 (value.subject.data as PlanSlots).steps[1].args[0]='demo feature other off';
 assert.ok(obligations(value).some(gap=>gap.verdict==='refute'),'changing an identity parameter is not cleanup');
});
test('an ambiguous paired target cannot fall back to a prefix inverse',()=>{
 const value=fixture(['demo feature on',cleanup('no demo feature on')]);
 const doc=catalogOf(value);
 const entry=doc.entries.find(entry=>entry.words.join(' ')==='demo feature')!;
 entry.signatures.push({...structuredClone(entry.signatures[0]),id:'off-only',reference:entry.signatures[0].reference+'/off-only',params:[{...structuredClone(entry.signatures[0].params[0]),values:['off']}]} as CommandDefinition['signatures'][number]);
 doc.entries.push({...structuredClone(entry),words:['no','demo','feature'],reference:'tree:'+doc.root+'/commands/no/demo/feature',signatures:[structuredClone(entry.signatures[0])]});
 doc.policy.inverse_rules.push({source_prefix:'/commands/demo/feature',inverse_prefix:'/commands/no/demo/feature',leading_parameters:1});
 assert.ok(obligations(value).some(gap=>gap.verdict==='unknown'));
});

test('a missing cleanup obligation encodes the declared paired literal with the existing quote grammar',()=>{
 const target='off \\ mode"';
 const value=fixture(['demo feature on'],{...policyWithoutPairs,inverse_alternatives:[['on',target]]});
 const entry=catalogOf(value).entries.find(entry=>entry.words.join(' ')==='demo feature')!;
 entry.signatures[0].params[0].values=['on',target];
 const missing=obligations(value).find(gap=>gap.verdict==='refute');assert.ok(missing);
 const expected=missing.obligation?.inverse as import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity;
 assert.equal(expected.parameters[0].parsed.kind,'text');assert.equal((expected.parameters[0].parsed as {value:string}).value,target);
});

test('a declared sibling pair with no paired leaf cannot authorize repeated cleanup',()=>{
 const value=fixture(['demo switch on',cleanup('demo switch on')]);
 const doc=catalogOf(value);doc.entries=doc.entries.filter(entry=>entry.words.join(' ')!=='demo switch off');
 assert.ok(obligations(value).some(gap=>gap.verdict==='unknown'));
});

// A union argument type: the product's command-tree producer publishes a native IPADDR argument as one catalog signature
// per address family (ids 1.1 and 1.2) under the same native reference (issue #56). Synthetic commands only.
const unionEntry=(words:string[],item:number,state?:string[])=>{
 const root=catalogOf(fixture([])).root,reference=`src:${root}/xml@1/x/commands/item[${item}]/arguments`;
 const arg=(position:number,name:string,type:'enum'|'ipv4'|'ipv6'|'int',nativeName:string,values?:string[])=>({name,type,...(values?{values:[...values]}:{}),native_type:{name:nativeName,declaration:`${reference}/arg[${position+1}]`,grammar:'famx-command-tree@2'}});
 const lead=state?1:0;
 return {words,reference:'tree:'+root+'/commands/'+words.join('/'),signatures:(['ipv4','ipv6'] as const).map((family,j)=>({id:`1.${j+1}`,reference,params:[...(state?[arg(0,'state','enum','ENUM',state)]:[]),arg(lead,'address',family,'IPADDR'),arg(lead+1,'port','int','U16')]}))};
};
const withUnions=(lines:Parameters<typeof fixture>[0])=>{
 const value=fixture(lines),doc=catalogOf(value);
 doc.entries.push(unionEntry(['demo','peer','add'],101),unionEntry(['no','demo','peer','add'],102),unionEntry(['demo','bind'],103,['on','off']));
 doc.policy.inverse_rules.push({source_prefix:'/commands/demo/peer',inverse_prefix:'/commands/no/demo/peer'});
 return value;
};
test('an address union under one signature reference is no enum alternative: the declared prefix inverse still applies',()=>{
 assert.deepEqual(obligations(withUnions(['demo peer add 192.0.2.74 80',cleanup('no demo peer add 192.0.2.74 80')])),[]);
 assert.deepEqual(obligations(withUnions(['demo peer add 2001:db8::74 80',cleanup('no demo peer add 2001:db8::74 80')])),[]);
 const changed=obligations(withUnions(['demo peer add 192.0.2.74 80',cleanup('no demo peer add 192.0.2.75 80')]));
 assert.ok(changed.some(gap=>gap.verdict==='refute'),JSON.stringify(changed));
 const missing=obligations(withUnions(['demo peer add 192.0.2.74 80']));
 assert.ok(missing.some(gap=>gap.verdict==='refute'&&gap.obligation?.inverse_path==='/commands/no/demo/peer/add'),JSON.stringify(missing));
});
test('a declared enum pair still inverts a signature that an address union expands',()=>{
 assert.deepEqual(obligations(withUnions(['demo bind on 192.0.2.74 80',cleanup('demo bind off 192.0.2.74 80')])),[]);
 const repeated=obligations(withUnions(['demo bind on 192.0.2.74 80',cleanup('demo bind on 192.0.2.74 80')]));
 assert.ok(repeated.some(gap=>gap.verdict==='refute'&&gap.message.includes('声明的枚举互逆')),JSON.stringify(repeated));
});
test('expansions of one signature that disagree on a paired enum stay ambiguous',()=>{
 const value=withUnions(['demo bind on 192.0.2.74 80',cleanup('demo bind off 192.0.2.74 80')]);
 const bind=catalogOf(value).entries.find(entry=>entry.words.join(' ')==='demo bind')!;
 bind.signatures[1].params[0].values=['on','off','auto'];
 assert.ok(obligations(value).some(gap=>gap.verdict==='unknown'));
});
