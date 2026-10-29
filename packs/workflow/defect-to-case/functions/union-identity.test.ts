// A union argument type (an address of either family) is published by a product's command-tree producer as one catalog
// signature per alternative under the same native signature reference (ids 1.1 and 1.2), and a CommandIdentity names
// that shared reference. Synthetic commands only; addresses come from 192.0.2.0/24 and 2001:db8::/32.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {CatalogParam,CatalogSignature} from '../../../../contracts/src/tables.ts';
import {buildCatalog} from '../../../../hub/rules/api.ts';
import {SYNTHETIC_INDEX_VIEW,goodDraft} from '../testing/fixtures.ts';
import {nativeExpected} from '../testing/structure.ts';
import {commandIdentity} from './case-identity.ts';
import {checkDuplicate} from './checks.ts';
import {CODES} from './types.ts';

type Family='ipv4'|'ipv6';
const TREE=createHash('sha256').update('synthetic union command tree').digest('hex');
const SIGNATURE=`src:${TREE}/xml@1/x/commands/item[1]/arguments`,PATH='/commands/widget/peer/add',ROOT='a'.repeat(64);
const native=(position:number,name:string)=>({name,declaration:`${SIGNATURE}/arg[${position+1}]`,grammar:'synthetic-tree@1'});
const address=(type:Family):CatalogParam=>({name:'address',type,native_type:native(0,'IPADDR')});
const port=():CatalogParam=>({name:'port',type:'int',minimum:1,maximum:65535,native_type:native(1,'U16')});
const expansions=(families:readonly Family[]=['ipv4','ipv6']):CatalogSignature[]=>families.map((family,j)=>({id:`1.${j+1}`,reference:SIGNATURE,params:[address(family),port()]}));
const catalog=(signatures=expansions())=>buildCatalog({root:ROOT,complete:true,caseSensitive:true,entries:[{head:'widget peer add',reference:`tree:${ROOT}${PATH}`,signatures}]}).entries();
const identity=(value:string,family:Family,number=80):CommandIdentity=>({tree_root:TREE,path:PATH,signature:SIGNATURE,parameters:[
 {position:0,name:'address',raw:value,type:{...native(0,'IPADDR'),catalog_type:family},parsed:{kind:'address',value:{kind:family,value}}},
 {position:1,name:'port',raw:String(number),type:{...native(1,'U16'),catalog_type:'int'},parsed:{kind:'int',value:number}},
]});
const V4='192.0.2.74',V6='2001:db8::74';

test('an argument of either family matches its own alternative under the shared signature reference',()=>{
 for(const families of [['ipv4','ipv6'],['ipv6','ipv4']] as const){
  assert.deepEqual(commandIdentity(identity(V4,'ipv4'),catalog(expansions(families))),identity(V4,'ipv4'),families.join());
  assert.deepEqual(commandIdentity(identity(V6,'ipv6'),catalog(expansions(families))),identity(V6,'ipv6'),families.join());
 }
});

test('a prefix length matches the integer alternative a mask union lists after the dotted mask',()=>{
 const masks=([{type:'mask'},{type:'int',minimum:0,maximum:128}] as const).map((alternative,j):CatalogSignature=>({id:`1.${j+1}`,reference:SIGNATURE,params:[{name:'mask',...alternative,native_type:native(0,'IPMASK')}]}));
 const mask=(raw:string,parsed:CommandIdentity['parameters'][number]['parsed']):CommandIdentity=>({tree_root:TREE,path:PATH,signature:SIGNATURE,parameters:[{position:0,name:'mask',raw,type:{...native(0,'IPMASK'),catalog_type:parsed.kind==='int'?'int':'mask'},parsed}]});
 const prefix=mask('24',{kind:'int',value:24}),dotted=mask('255.255.255.0',{kind:'address',value:{kind:'mask',value:'255.255.255.0'}});
 assert.deepEqual(commandIdentity(prefix,catalog(masks)),prefix);
 assert.deepEqual(commandIdentity(dotted,catalog(masks)),dotted);
 assert.equal(commandIdentity(mask('129',{kind:'int',value:129}),catalog(masks)),null,'prefix length above its declared maximum');
});

test('an argument still has to satisfy an alternative the signature reference declares',()=>{
 assert.equal(commandIdentity(identity(V6,'ipv6',70000),catalog()),null,'port above its declared maximum');
 assert.equal(commandIdentity(identity(V6,'ipv6'),catalog(expansions(['ipv4']))),null,'no IPv6 alternative');
 const mask=identity('255.255.255.0','ipv4');mask.parameters[0].type.catalog_type='mask';mask.parameters[0].parsed={kind:'address',value:{kind:'mask',value:'255.255.255.0'}};
 assert.equal(commandIdentity(mask,catalog()),null,'no mask alternative');
 // Alternatives are read as the overloads they are: one expansion's address and another's port make no identity.
 const mixed=expansions();mixed[1].params[1]={name:'port',type:'string',native_type:native(1,'U16')};
 assert.equal(commandIdentity(identity(V6,'ipv6'),catalog(mixed)),null,'IPv6 with an int port is no declared expansion');
 assert.deepEqual(commandIdentity(identity(V4,'ipv4'),catalog(mixed)),identity(V4,'ipv4'));
});

test('expansions that disagree outside the typed alternative leave every identity unresolved',()=>{
 const disagreements:Array<[string,(signatures:CatalogSignature[])=>void]>=[
  ['parameter name',signatures=>{signatures[1].params[0].name='peer';}],
  ['native type',signatures=>{signatures[1].params[1].native_type=native(1,'U32');}],
  ['optional flag',signatures=>{signatures[1].params[1].optional=true;}],
  ['argument count',signatures=>{signatures[1].params.push({name:'weight',type:'int',optional:true,native_type:native(2,'U16')});}],
 ];
 for(const [what,change] of disagreements){
  const signatures=expansions();change(signatures);
  assert.equal(commandIdentity(identity(V4,'ipv4'),catalog(signatures)),null,what+' (IPv4)');
  assert.equal(commandIdentity(identity(V6,'ipv6'),catalog(signatures)),null,what+' (IPv6)');
 }
});

test('an IPv6 draft is compared by its declared structure instead of staying unresolved',()=>{
 const entry='3'.repeat(64),expected=nativeExpected(),view=structuredClone(SYNTHETIC_INDEX_VIEW);
 view.keys={[PATH]:[entry]};view.total_keys=1;view.total_entries=1;
 view.entries={[entry]:{entry,kind:'case',statement:'doc_201:node_7 | 合成对端地址配置',reference:`tree:${'1'.repeat(64)}${PATH}@${entry}`,data:{case_structure:{schema:'case-structure@2',commands:[identity(V6,'ipv6')],expected:[{after:1,quote:expected.identity}]},document:'doc_201',node:'node_7',title:'合成对端地址配置',negative:false,commands:[PATH],expected_texts:[expected.text]}}};
 const draft=(value:string,family:Family)=>goodDraft({id:'draft-'+family,steps:[{command:`widget peer add ${value} 80`,identity:identity(value,family)}],expected:[expected]});
 const same=checkDuplicate({subject:{item:'synthetic',drafts:[draft(V6,'ipv6')],indexed_cases:view},catalog:catalog()})[0];
 assert.equal(same.verdict,'refute',JSON.stringify(same));assert.equal(same.code,CODES.DUPLICATE_CASE);
 const other=checkDuplicate({subject:{item:'synthetic',drafts:[draft(V4,'ipv4')],indexed_cases:view},catalog:catalog()})[0];
 assert.equal(other.verdict,'support',JSON.stringify(other));
});
