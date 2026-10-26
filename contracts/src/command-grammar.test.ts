import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CatalogEntry} from './tables.ts';
import {ProducerOutput} from './product.ts';
const gap={path:'./arguments/arg/@type',reason:'missing_input',missing:'structured native type',next_action:'Package author must declare the type before the next production'};
export const undeclared={name:'peer',type_declaration_status:'undeclared',unchecked_constraints:[gap]};
test('R4 a native parameter position is retained without inventing a generic type',()=>{
 const value={words:['demo'],signatures:[{params:[undeclared]}],reference:`tree:${'a'.repeat(64)}/commands/demo`};
 const parsed=CatalogEntry.parse(value);assert.equal(parsed.signatures[0].params[0].type,undefined);
 for(const param of [{name:'peer'},{...undeclared,type:'string'},{name:'peer',type_declaration_status:'undeclared'}])assert.equal(CatalogEntry.safeParse({...value,signatures:[{params:[param]}]}).success,false);
});
test('R4 producer diagnostics carry grammar identity, structured states and a concrete recovery',()=>{
 const output={entries:[],warnings:[],grammar:{id:'famx-command-tree@2',source:'product:famx/README.md',complete:false},diagnostics:[{command:['demo'],path:'x/commands/item/arguments/arg/@type',attribute:'type',position:1,type_declaration_status:'undeclared',command_parse_status:'parameters_unchecked',syntax_valid:true,reason:'missing_input',missing:'structured native type',next_action:'补类型后重产',audience:'命令树维护者',due:'下一次生产之前'}]};
 assert.deepEqual(ProducerOutput.parse(output),output);
 const invalid=structuredClone(output);invalid.diagnostics[0].command_parse_status='unknown';assert.equal(ProducerOutput.safeParse(invalid).success,false);
});
