import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SyncPlanOutput} from './product.ts';
const build={name:'Rel_SYNTHETIC_10_6_1_7',family:'SYNTHETIC',line:'10.6.1',base:'Rel_SYNTHETIC_10_6_1_7',platform:null,built_at:null,released_at:null,sources:{}};
test('sync plans may retain failed build observations only with a registered reason and a repair action',()=>{
 const failed={source:'site:page:synthetic',build,raw:{built:'synthetic-invalid-time'},reason:'SOURCE_UNPARSEABLE',fix:'请构建站负责人修正日期后重新同步'};
 const plan={fetch:[],builds:[],done:true,failed_builds:[failed]};
 assert.equal(SyncPlanOutput.safeParse(plan).success,true);
 assert.equal(SyncPlanOutput.safeParse({...plan,failed_builds:[{...failed,reason:'free text is not a code'}]}).success,false);
 assert.equal(SyncPlanOutput.safeParse({...plan,failed_builds:[{...failed,fix:''}]}).success,false);
 assert.equal(SyncPlanOutput.safeParse({fetch:[],builds:[],done:true}).success,true);
});
