import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {test} from 'node:test';
import {supportedSlotSchema} from './slot-schema.ts';
import {packSchema} from '../hub/runs/engine/slots.ts';
test('slot projection removes unsupported keywords at schema nodes and preserves field names and structural bounds',()=>{
 const original={type:'object',patternProperties:{'^x':{type:'number'}},properties:{pattern:{type:'string',pattern:'^x',minLength:1},format:{type:'array',items:{anyOf:[{type:'string',format:'date-time'},{type:'string',pattern:'^y'}]}}},required:['pattern'],additionalProperties:false};
 assert.deepEqual(supportedSlotSchema(original),{type:'object',properties:{pattern:{type:'string',minLength:1},format:{type:'array',items:{anyOf:[{type:'string'},{type:'string'}]}}},required:['pattern'],additionalProperties:false});
 assert.ok(original.properties.pattern.pattern);assert.equal(packSchema(supportedSlotSchema(original) as Record<string,unknown>).ok,true);
});
test('every shipped workflow slot data schema is executable by the Hub',()=>{
 for(const name of readdirSync(new URL('../packs/workflow/',import.meta.url))){const file=new URL('../packs/workflow/'+name+'/slots.schema.json',import.meta.url);if(!existsSync(file))continue;const slots=JSON.parse(readFileSync(file,'utf8'));for(const scope of ['item','run'])for(const [id,declaration]of Object.entries(slots[scope]??{}) as Array<[string,{data?:Record<string,unknown>}]>){if(!declaration.data)continue;assert.deepEqual(supportedSlotSchema(declaration.data),declaration.data,`${name}/${scope}/${id} includes an unsupported keyword`);const result=packSchema(declaration.data);assert.ok(result.ok,result.ok?'':`${name}/${scope}/${id}: ${result.problem}`);}}
});
