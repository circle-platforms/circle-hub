import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createTestHub} from '../../../hub/server/testing-real.ts';
import {startWebDavStub,startStub,text} from '../../../hub/connectors/testing/api.ts';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../../hub/testing/postgres.ts';
import {connect,type McpClient} from '../../../tests/acceptance/support/mcp.ts';

const skip=await osIsolationAvailable()?false:'no OS network isolation';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(t:{after(fn:()=>Promise<void>):void},settings:Record<string,unknown>,files:Record<string,string>){
 const hub=await createTestHub({postgres,repositoryPacks:['source-read','manual-store'],stubs:false,mindmapSkill:false,workbookSkill:false,htmlSkill:false});t.after(()=>hub.close());
 await hub.assignPack(hub.admin.principal,'source-read');
 const stub=Object.keys(files).length?await startWebDavStub(files):await startStub(request=>request.method==='PROPFIND'&&request.path==='/empty/'?text('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/empty/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>','application/xml; charset=utf-8',207):text('not found','text/plain',404));t.after(()=>stub.close());
 const resource=await hub.addResource({system_pack:'manual-store',name:'合成规格目录',environment:'test',origins:{'manual-store':stub.origin},settings});
 const client=await connect(hub,hub.admin.token);t.after(()=>client.close());return {hub,stub,client,resource};
}
async function original(client:McpClient,run:{sources:{reference:string;slot?:string}[]}){
 const sources=run.sources.filter(row=>row.slot==='spec_list');let data:unknown;
 for(const source of sources){const answer=await client.call('get_nodes',{reference:source.reference});assert.equal(answer.out.call_result,'ok',answer.text);if(answer.out.content?.text){try{const value=JSON.parse(answer.out.content.text);if(Array.isArray(value.files))data=value;}catch{}}}
 assert.ok(data,'the inventory projection is readable by its bound source reference');return data as {files:{name:string;path:string}[];directories:{path:string}[];unread:string[];folders:string[];complete:boolean};
}
test('MCP discovers a specification list input, lists once and reads only the explicitly chosen exact file',{skip},async t=>{
 const content='# 需求 20931\n\n合成规格，名字不足以证明匹配；正文由调用方核对。\n';
 const {client,stub}=await world(t,{spec_folders:['spec','design']},{'/spec/neutral-name.md':content,'/spec/other.md':'# 其他合成文档','/design/child/deeper.md':'# 未展开子目录'});
 const listed=await client.call('list_task_packs',{pack_id:'source-read'});assert.equal(listed.out.call_result,'ok',listed.text);assert.match(JSON.stringify(listed.out),/manual:spec-list/);
 const before=stub.requests.length,inventory=await client.call('start_run',{pack:'source-read',inputs:{spec_list:{external:'manual:spec-list:configured'}}});assert.equal(inventory.out.call_result,'ok',inventory.text);assert.ok(inventory.out.run);
 const data=await original(client,inventory.out.run);assert.equal(data.complete,true);assert.deepEqual(data.folders,['spec','design']);assert.deepEqual(data.unread,[]);assert.deepEqual(data.files.map(row=>row.path).sort(),['spec/neutral-name.md','spec/other.md']);assert.deepEqual(data.directories.map(row=>row.path),['design/child']);
 assert.deepEqual(stub.requests.slice(before).map(row=>[row.method,decodeURIComponent(row.path)]),[['PROPFIND','/spec/'],['PROPFIND','/design/']]);
 const chosen=data.files.find(row=>row.path==='spec/neutral-name.md');assert.ok(chosen);const read=await client.call('start_run',{pack:'source-read',inputs:{manual_file:{external:'manual:file:'+chosen.path}}});assert.equal(read.out.call_result,'ok',read.text);assert.ok(read.out.run);const source=read.out.run.sources.find(row=>row.slot==='manual_file');assert.ok(source);const fetched=await client.call('get_nodes',{reference:source.reference});assert.equal(fetched.out.call_result,'ok',fetched.text);assert.equal(fetched.out.content?.text,content);
 assert.deepEqual(stub.requests.slice(before).map(row=>[row.method,decodeURIComponent(row.path)]),[['PROPFIND','/spec/'],['PROPFIND','/design/'],['GET','/spec/neutral-name.md']]);
});
test('a configured empty directory is an observed empty inventory and does not fetch any file',{skip},async t=>{
 const {client,stub}=await world(t,{spec_folders:['empty']},{});
 const read=await client.call('start_run',{pack:'source-read',inputs:{spec_list:{external:'manual:spec-list:configured'}}});assert.equal(read.out.call_result,'ok',read.text);assert.ok(read.out.run);const data=await original(client,read.out.run);assert.equal(data.complete,true);assert.deepEqual(data.files,[]);assert.deepEqual(data.directories,[]);assert.deepEqual(data.folders,['empty']);assert.equal(stub.requests.filter(row=>row.method==='GET').length,0);
});
test('an unread configured folder remains incomplete instead of becoming an empty global inventory',{skip},async t=>{
 const {client,stub}=await world(t,{spec_folders:['spec','unread']},{'/spec/neutral.md':'# 合成候选'});
 const read=await client.call('start_run',{pack:'source-read',inputs:{spec_list:{external:'manual:spec-list:configured'}}});assert.equal(read.out.call_result,'ok',read.text);assert.ok(read.out.run);const data=await original(client,read.out.run);assert.equal(data.complete,false);assert.deepEqual(data.unread,['unread']);assert.deepEqual(data.files.map(row=>row.path),['spec/neutral.md']);assert.equal(stub.requests.filter(row=>row.method==='GET').length,0);
});
test('a declared workflow input does not imply that its resource is enabled',{skip},async t=>{
 const {client,stub,hub,resource}=await world(t,{spec_folders:['spec']},{'/spec/neutral.md':'# 合成候选'});await hub.hub.connectors.admin.disable(hub.admin.principal,resource.id);
 const discovered=await client.call('list_task_packs',{pack_id:'source-read'});assert.match(JSON.stringify(discovered.out),/manual:spec-list/);
 const read=await client.call('start_run',{pack:'source-read',inputs:{spec_list:{external:'manual:spec-list:configured'}}});assert.equal(read.out.call_result,'error',read.text);assert.equal(stub.requests.length,0);assert.ok(!read.out.errors.some(row=>row.code==='SOURCE_ABSENT'));
});
test('undeclared specification folders refuse before reading and do not become an empty inventory',{skip},async t=>{
 const {client,stub}=await world(t,{}, {'/spec/neutral.md':'# 尚未列出的合成规格'});
 const read=await client.call('start_run',{pack:'source-read',inputs:{spec_list:{external:'manual:spec-list:configured'}}});assert.equal(read.out.call_result,'error',read.text);assert.equal(stub.requests.length,0);assert.equal(read.out.run,undefined);assert.ok(!read.out.errors.some(row=>row.code==='SOURCE_ABSENT'));
});
