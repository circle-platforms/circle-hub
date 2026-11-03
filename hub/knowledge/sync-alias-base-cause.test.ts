// Issue 31: an alias whose base build has no root fails for the base's own reason, passed on with the step that gives the
// base a root and the command that syncs the line again; never a generic "no usable root".
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {BASE_CATALOG,catalogXml,makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
const name='Rel_ACME_10_7_1_71';
const base={name,family:'ACME',line:'10.7.1',base:name,platform:null,built_at:null,released_at:'2026-10-01T00:00:00.000Z',sources:{tree:'site:tree:synthetic-missing'}};
const alias={...base,name:'Rel_ZETA_10_7_1_72',family:'ZETA',sources:{}};

test('issue 31: an alias whose base failed to produce carries the base failure, its next step and the sync command',async t=>{
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':`export default ()=>({fetch:[],builds:${JSON.stringify([base,alias])},done:true});`}}});t.after(()=>w.close());
 w.external.set('site:page:index',{bytes:'<p>synthetic index</p>',mediaType:'text/html'});
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);
 const baseRow=report.builds.find(row=>row.name===name)!,aliasRow=report.builds.find(row=>row.name===alias.name)!;
 assert.equal(baseRow.outcome,'failed',JSON.stringify(baseRow));
 assert.equal(aliasRow.outcome,'failed',JSON.stringify(aliasRow));
 assert.ok(aliasRow.reason.includes(`这次同步里它失败了（${baseRow.reason.slice(0,40)}`),aliasRow.reason);
 assert.match(aliasRow.reason,/下一步：.*重新同步这条版本线（circle-hub knowledge sync --product ACME --line 10\.7\.1）/);
 assert.equal(aliasRow.reason_code,baseRow.reason_code);
 const requests=await w.kit.store.find<any>({key:'action.kind',value:'read',kind:'action',limit:100});
 assert.ok(requests.items.some(row=>String(row.body.detail?.missing).includes(`别名 ${alias.name} 依赖的基础构建 ${name} 没有可用根：这次同步里它失败了`)),JSON.stringify(requests.items.map(row=>row.body.detail)));
});

test('issue 31: an alias whose base the plan listed without a readable source says so and whose step it is',async t=>{
 const bare={...base,sources:{}};
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':`export default ()=>({fetch:[],builds:${JSON.stringify([bare,alias])},done:true});`}}});t.after(()=>w.close());
 w.external.set('site:page:index',{bytes:'<p>synthetic index</p>',mediaType:'text/html'});w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);
 assert.equal(report.builds.find(row=>row.name===name)?.outcome,'registered');
 const aliasRow=report.builds.find(row=>row.name===alias.name)!;
 assert.equal(aliasRow.outcome,'failed');
 assert.match(aliasRow.reason,/计划没有给它列出可读的来源，只登记了名字；下一步：由产品包作者核对计划为什么没给它列出来源/);
 assert.match(aliasRow.reason,/circle-hub knowledge sync --product ACME --line 10\.7\.1/);
});
