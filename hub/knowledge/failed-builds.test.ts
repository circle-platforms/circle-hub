import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('a failed plan build remains queryable with its original material and a no-root identity',async t=>{
 const build={name:'Rel_ACME_10_6_1_71',family:'ACME',line:'10.6.1',base:'Rel_ACME_10_6_1_71',platform:null,built_at:null,released_at:null,sources:{}};
 const failed={source:'site:page:index',build,raw:{built:'synthetic-invalid-time'},reason:'SOURCE_UNPARSEABLE',fix:'请构建站负责人修正日期后重新同步'};
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':`export default ()=>(${JSON.stringify({fetch:[],builds:[],done:true,failed_builds:[failed]})});`}}});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product,{lines:['10.6.1']});
 assert.equal(report.error,null,JSON.stringify(report));assert.equal(report.counts.failed,1);
 assert.equal(report.builds[0].reason_code,'SOURCE_UNPARSEABLE');assert.equal(report.builds[0].root,null);
 assert.equal((await w.knowledge.resolveBuild('acme',build.name))?.root,null);
 const rows=await w.knowledge.store.buildFailures('acme',{name:build.name});assert.equal(rows.length,1);
 assert.equal(rows[0].body.error_code,'SOURCE_UNPARSEABLE');assert.deepEqual(rows[0].body.detail.raw,failed.raw);
 assert.equal((await w.knowledge.store.buildFailures('acme',{root:null})).length,1);
});
