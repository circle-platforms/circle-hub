// Decision 91: exact capacity units and historical correction through the real HTTP/MCP boundary.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from '../../hub/server/testing-real.ts';
import {legacyRootSource} from '../../hub/knowledge/testing-capacity.ts';
import {formatCapacity,exactBytes,capacityInput} from '../../hub/server/capacity.ts';
import {wordingProblems} from '../../hub/server/console/testing-wording.ts';
import {openConsole} from './support/console.ts';
import {connect} from './support/mcp.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
test('administrators adjust exact units, reject invalid conversions and preserve existing non-MB limits without rounding',async()=>{
 const hub=await createTestHub(options);try{
  const user=await hub.createUser('合成容量成员'),spaces=hub.hub.knowledge.spaces!,manager=await openConsole(hub,hub.admin.token),owner=await openConsole(hub,user.token),url='/console/team/'+user.user.id;
  await spaces.setCapacity(hub.admin.principal,user.user.id,99793);
  const page=await manager.get(url);assert.equal(page.status,200);assert.deepEqual(wordingProblems(page.body),[]);assert.match(page.body,/97\.5 KB/);assert.match(page.body,/title="99,793 字节"/);assert.match(page.body,new RegExp('name="amount"[^>]*value="'+capacityInput(99793).amount.replaceAll('.','\\.')+'"'));assert.match(page.body,/<option value="mb" selected>MB<\/option>/);assert.match(page.body,/<option value="gb">GB<\/option>/);assert.doesNotMatch(page.body,/<input[^>]*name="bytes"/);assert.match(page.body,/已有内容保留/);
  const change=(amount:string,unit:string,extra:Record<string,string>={})=>manager.post('/console/knowledge/do/quota',{csrf:csrf(page.body),space:user.user.id,amount,unit,...extra});
  for(const [amount,unit] of [['-1','gb'],['0.1','mb'],['0.00000000001','gb'],['9007199254740992','gb'],['1e3','mb'],['1','kb'],['','mb']]){const refused=await change(amount,unit);assert.equal(refused.status,400,refused.body);assert.equal((await spaces.usage(user.principal)).limit,99793);}
  assert.equal((await manager.post('/console/knowledge/do/quota',{csrf:csrf(page.body),space:user.user.id,bytes:'1'})).status,400);
  assert.equal((await change(capacityInput(99793).amount,'mb')).status,303);assert.equal((await spaces.usage(user.principal)).limit,99793);
  assert.equal((await change('0.5','mb',{bytes:'999999999'})).status,303);assert.equal((await spaces.usage(user.principal)).limit,524288);
  const own=await owner.get('/console/knowledge');assert.equal((await owner.post('/console/knowledge/do/quota',{csrf:csrf(own.body),space:user.user.id,amount:'1',unit:'gb'})).status,404);
  assert.equal((await change('1','gb',{csrf:'invalid'})).status,403);assert.equal((await spaces.usage(user.principal)).limit,524288);
  const stale=await hub.createUser('合成失效管理员','admin'),staleWeb=await openConsole(hub,stale.token),stalePage=await staleWeb.get(url);await hub.records.principals.setDisabled(hub.admin.principal,stale.user.id,true);
  assert.equal((await staleWeb.post('/console/knowledge/do/quota',{csrf:csrf(stalePage.body),space:user.user.id,amount:'1',unit:'gb'})).status,303);assert.equal((await spaces.usage(user.principal)).limit,524288);
 }finally{await hub.close();}
});
test('legacy low usage is corrected for owner/admin, rejected with exact facts and retained below a zero limit including shared originals',async()=>{
 const hub=await createTestHub(options);try{
  const user=await hub.createUser('合成旧计量成员'),peer=await hub.createUser('合成容量读者'),spaces=hub.hub.knowledge.spaces!,legacy=await legacyRootSource(hub.records,user.principal),manager=await openConsole(hub,hub.admin.token),owner=await openConsole(hub,user.token),reader=await openConsole(hub,peer.token),client=await connect(hub,user.token);
  try{
   await spaces.setCapacity(hub.admin.principal,user.user.id,16384);await spaces.grant(user.principal,{path:'/',audience:'member',member:peer.user.id});
   const mark=await hub.records.store.watermark!(),old=await hub.records.store.get(legacy.record!.digest),ownUrl='/console/knowledge/space?'+new URLSearchParams({space:user.user.id,path:'/'}),own=await owner.get(ownUrl),home=await owner.get('/console/knowledge?scope=personal'),admin=await manager.get('/console/team/'+user.user.id);
   for(const body of [own.body,home.body,admin.body]){assert.match(body,new RegExp(formatCapacity(legacy.expected).replaceAll('.','\\.')));assert.ok(body.includes('title="'+exactBytes(legacy.expected)+'"'));assert.deepEqual(wordingProblems(body),[]);}
   assert.equal(await hub.records.store.watermark!(),mark,'rendering corrected usage never appends records');assert.doesNotMatch(admin.body,/合成原文。|合成旧计量原文/);
   const denied=await owner.post('/console/knowledge/do/entry',{csrf:csrf(own.body),path:'/',kind:'observation',statement:'合成应拒收写入'});assert.equal(denied.status,400,denied.body);for(const text of ['私人空间容量不足','剩余','本次新增','0.0 KB',exactBytes(legacy.expected)])assert.ok(denied.body.includes(text),text);assert.deepEqual(wordingProblems(denied.body),[]);
   const memory={title:'合成超限记忆',markdown:'合成正文',expected_version:null,client_key:'same-capacity-mcp-retry'},refused=await client.call('upload_file',{memory});assert.equal(refused.out.errors[0]?.code,'SPACE_CAPACITY_EXCEEDED');for(const text of ['已用','上限','剩余','本次新增',exactBytes(legacy.expected)])assert.ok(refused.text.includes(text),text);
   await spaces.setCapacity(hub.admin.principal,user.user.id,0);assert.ok((await spaces.usage(user.principal)).over>0);const original='/console/knowledge/source?'+new URLSearchParams({sha256:legacy.file.body.sha256,artifact:legacy.file.digest});assert.equal((await reader.get(original)).status,200);assert.deepEqual(await hub.records.store.get(legacy.record!.digest),old);assert.deepEqual(Buffer.from((await hub.records.objects.get(legacy.file.body.sha256))!),legacy.bytes);
   await spaces.setCapacity(hub.admin.principal,user.user.id,1048576);const accepted=await client.call('upload_file',{memory});assert.equal(accepted.isError,false,accepted.text);const usage=await spaces.usage(user.principal);assert.ok(usage.memory>0);assert.equal(usage.used,usage.knowledge+usage.memory);assert.equal((await client.call('upload_file',{memory})).out.memory_write?.version,accepted.out.memory_write?.version,'accepted retry stays idempotent');
   const fresh=await owner.get(ownUrl);assert.ok(fresh.body.includes(exactBytes(usage.used)));assert.ok((await owner.get('/console/knowledge?scope=personal')).body.includes(exactBytes(usage.used)));assert.equal((await owner.post('/console/knowledge/do/entry',{csrf:csrf(fresh.body),path:'/',kind:'observation',statement:'合成提高容量后重试'})).status,303);
  }finally{await client.close();}
 }finally{await hub.close();}
});
