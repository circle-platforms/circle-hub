import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {credentialReviewRequests} from '../knowledge/api.ts';
import type {ActionBody,StoredRecord} from '../records/api.ts';

const now=new Date();

test('administrator source-review queue is paginated, access-checked and readable without source bytes or findings',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成私人作者'),member=await hub.createUser('合成普通成员'),other=await hub.createUser('合成核看管理员','admin');
 const heldText='password = SyntheticReview72#value';
 const source=await hub.records.artifacts.ingest({bytes:Buffer.from(heldText),mediaType:'text/plain',origin:{read:{object:'synthetic:document:reviewed'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
 assert.equal(source.body.read_tier,'retain_only');
 const privateSource=await hub.records.artifacts.ingest({bytes:Buffer.from('合成私人原文'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:private'}},author:{user:owner.user.id},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:false,packs:[],shareable:false}});
 const request=async(index:number,record=source)=>hub.records.store.put<ActionBody>({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,inputs:[`src:${record.body.sha256}`],component:'knowledge.sync@1',lease:null,started_at:now.toISOString(),ended_at:now.toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{credential:{sha256:record.body.sha256,record:record.digest,external:index===4?'synthetic:document:password=SyntheticHidden72#value':'synthetic:document:review-'+index},audience_user:other.user.id,deadline:new Date(now.getTime()+(index%2?-1:1)*3600000).toISOString(),request_kind:'clarification'}} ,index:[{key:'knowledge.credential.request.all',value:'1'}]});
 const entries:StoredRecord<ActionBody>[]=[];for(let i=0;i<5;i++)entries.push(await request(i));const hidden=await request(6,privateSource);
 const status=async(key:string,field:string,digest:string)=>hub.records.store.put<ActionBody>({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,inputs:[`rec:${digest}`],component:'knowledge.sync@1',lease:null,started_at:now.toISOString(),ended_at:now.toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{[field]:digest}},index:[{key,value:digest}]});
 await status('knowledge.credential.resolved','resolved_request',entries[0].digest);await status('knowledge.credential.expired','expired_request',entries[1].digest);
 const mark=await hub.records.store.watermark!(),sourceRead=hub.records.artifacts.source.bind(hub.records.artifacts);hub.records.artifacts.source=async()=>{throw Error('queue must not read source bytes');};t.after(()=>{hub.records.artifacts.source=sourceRead;});
 const all=[];let cursor:string|null=null;do{const page=await credentialReviewRequests(hub.records,hub.admin.principal,{limit:2,cursor,now});all.push(...page.items);cursor=page.next;}while(cursor);
 const canRead=hub.records.artifacts.canRead.bind(hub.records.artifacts);hub.records.artifacts.canRead=async()=>false;assert.deepEqual((await credentialReviewRequests(hub.records,hub.admin.principal,{now})).items,[]);hub.records.artifacts.canRead=canRead;
 assert.equal(all.length,5);assert.ok(!JSON.stringify(all).includes(hidden.digest));assert.equal(all.find(row=>row.reference.endsWith(entries[0].digest))?.resolved,true);assert.equal(all.find(row=>row.reference.endsWith(entries[1].digest))?.superseded,true);assert.ok(all.some(row=>row.expired));assert.equal(all.find(row=>row.reference.endsWith(entries[4].digest))?.external,null);
 assert.ok(!JSON.stringify(all).includes(heldText));assert.equal(await hub.records.store.watermark!(),mark);
 const manager=await openConsole(hub,hub.admin.token),reader=await openConsole(hub,member.token),page=await manager.get('/console/records');assert.equal(page.status,200,page.body);
 for(const value of ['来源核看请求','合成核看管理员','期限','已有解决记录','已到期并生成后续请求','等待管理员核看','不代表管理员已收到外部通知','circle-hub source held'])assert.ok(page.body.includes(value),value);
 for(const value of [heldText,privateSource.body.sha256,hidden.digest,'SyntheticHidden72'])assert.ok(!page.body.includes(value),value);
 const neutral=await reader.get('/console/records');assert.equal(neutral.status,200);assert.ok(!neutral.body.includes('来源核看请求'));assert.ok(!neutral.body.includes(source.body.sha256));
 await assert.rejects(credentialReviewRequests(hub.records,member.principal),{code:'SOURCE_UNAVAILABLE'});
 await hub.records.principals.setDisabled(hub.admin.principal,other.user.id,true);await assert.rejects(credentialReviewRequests(hub.records,other.principal),{code:'SOURCE_UNAVAILABLE'});
});
