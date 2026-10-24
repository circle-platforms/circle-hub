import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import {commandKey,readCommandIdentity} from './command-identity.ts';
const root='a'.repeat(64),ref=`tree:${root}/commands/demo`;
const identity:CommandIdentity={tree_root:root,path:'/commands/demo',signature:ref,parameters:[{position:0,name:'n',type:{name:'quantity',grammar:'demo@1',declaration:ref,catalog_type:'int'},raw:'01',parsed:{kind:'int',value:1}}]};
test('full typed identity ignores raw/role annotations but preserves each authoritative identity input',()=>{
 assert.ok(readCommandIdentity(identity,root));
 assert.equal(commandKey(identity),commandKey({...identity,parameters:[{...identity.parameters[0],raw:'1',role:{name:'synthetic-role',declaration:ref}}]}));
 for(const changed of [{...identity,path:'/commands/other'},{...identity,signature:`${ref}/overload`},{...identity,tree_root:'b'.repeat(64)},{...identity,parameters:[{...identity.parameters[0],parsed:{kind:'int',value:2}}]},{...identity,parameters:[{...identity.parameters[0],type:{...identity.parameters[0].type,declaration:`${ref}/other`}}]}] as CommandIdentity[])assert.notEqual(commandKey(identity),commandKey(changed));
});
test('legacy paths, wrong roots and incomplete or duplicated parameter positions are not full identities',()=>{
 for(const value of [ref,{}, {...identity,tree_root:'b'.repeat(64)},{...identity,parameters:[identity.parameters[0],identity.parameters[0]]},{...identity,parameters:[{...identity.parameters[0],type:{name:'quantity'}}]}])assert.equal(readCommandIdentity(value,root),null);
});
