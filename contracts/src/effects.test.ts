import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RequirementsFile} from './pack.ts';
const requirement={key:'verified',name:'核验',description:'合成核验',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['checked'],error_handling:[]};
const effect={id:'run_checked',resource_kind:'executor',action:'submit',effect_class:'job',parameters:{values:{target:['synthetic-bed']}},release:{requirements:['verified'],artifact:'verified'},trigger:'hub_template',budget:{count:1,duration_ms:{executor_max_run_ms:true}},deadline_ms:86400000,optional:false,policy_checks:['checked']};
test('requirements freeze an optional allowed-effect table and reject invalid operation and trigger declarations',()=>{
 const parse=(row:unknown)=>RequirementsFile.safeParse({schema:'requirements@1',requirements:[requirement],effects:[row]});
 assert.ok(parse(effect).success);
 for(const patch of [{effect_class:'sync_write'},{trigger:'automatic'},{action:'invented'},{budget:{count:0,duration_ms:20}},{deadline_ms:0},{parameters:{policy:'tables/unscoped.json',check:'checked'}}])assert.equal(parse({...effect,...patch}).success,false,JSON.stringify(patch));
 assert.ok(parse({...effect,parameters:{policy:'policies/dispatch.json',check:'checked'}}).success);
 assert.ok(RequirementsFile.safeParse({schema:'requirements@1',requirements:[requirement]}).success);
});
