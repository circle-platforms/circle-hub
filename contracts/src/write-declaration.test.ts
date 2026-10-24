import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {z} from 'zod';
import * as resources from './resources.ts';
const shapes=resources as unknown as Record<string,z.ZodType>;
const declaration={interaction:'submit_then_read',effect_class:'job',retry_safety:'unsafe',signing:'service_on_behalf',reversible:false,target_key:{$value:'resources'},audience:null,evidence:{call:'read_blob',pointer:'/digest'},refusal:{stage:'/stage',reached_device:'/reached'},writes_hub_records:true};
test('write declarations are public contracts with typed safety and complete observation fields',()=>{
 assert.ok(shapes.WriteDeclaration,'write declaration contract is missing');
 assert.ok(shapes.WriteDeclaration.safeParse(declaration).success);
 for(const patch of [{interaction:'synchronous'},{effect_class:'invented'},{retry_safety:'retry_always'},{signing:'anonymous'},{reversible:'yes'},{target_key:undefined},{evidence:{call:'read_blob',pointer:'not-a-pointer'}},{refusal:{stage:'/stage'}},{writes_hub_records:'yes'}])assert.equal(shapes.WriteDeclaration.safeParse({...declaration,...patch}).success,false,JSON.stringify(patch));
 assert.ok(shapes.WriteDeclaration.safeParse({...declaration,before_state:{call:{tool:'read_state',arguments:{}},pointer:'/state',expected:{$value:'build'},conditional_write:true}}).success);
 assert.ok('executor@1' in resources.schemas,'executor is not published');
});
test('the published executor JSON Schema restricts its write to a recorded job without an audience',async()=>{
 const {readFile}=await import('node:fs/promises');const schema=JSON.parse(await readFile(new URL('../generated/schemas/executor.v1.schema.json',import.meta.url),'utf8'));
 const write=schema.properties.calls.properties.submit.properties.write.properties;
 const requirements=JSON.parse(await readFile(new URL('../generated/schemas/requirements.v1.schema.json',import.meta.url),'utf8'));
 assert.deepEqual(requirements.properties.effects.items.properties.effect_class.enum,['job']);
 assert.deepEqual(write.effect_class.enum,['job']);assert.equal(write.audience.type,'null');assert.equal(write.writes_hub_records.const,true);
});
