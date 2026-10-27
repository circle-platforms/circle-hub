import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import type {CredentialFindingsPage} from './api.ts';
import {openTestRecords} from '../testing/records.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('administrators page every finding without values and can accept detector classes separately',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic administrator');
 const user=await kit.principals.createUser(admin,'synthetic reader');
 const values=Array.from({length:143},(_,i)=>`SyntheticSecret${i}#72`);
 const bearer=['SyntheticBearer73','AbcDefGh'].join('');
 const bytes=Buffer.from(values.map(value=>`password = ${value}`).join('\n')+'\nAuthorization: Bearer '+bearer+'\n');
 const artifact=await kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{read:{object:'synthetic:document:examples'}},author:{user:null},provenanceType:'observed',visibility:{readers:[user.id],admins:true,packs:[],shareable:false}});
 assert.equal(artifact.body.scan.truncated,true);
 let after:string|null=null,count=0;const offsets=new Set<string>();
 do{
  const page:CredentialFindingsPage=await kit.artifacts.scanFindings(admin,artifact.body.sha256,{after,limit:37});
  assert.equal(page.total,144);assert.ok(page.findings.length<=37);
  for(const finding of page.findings){const key=`${finding.detector}:${finding.offset}`;assert.ok(!offsets.has(key));offsets.add(key);}
  const shown=JSON.stringify(page);for(const value of values)assert.ok(!shown.includes(value));assert.ok(!shown.includes('SyntheticBearer73AbcDefGh'));
  count+=page.findings.length;after=page.next;
 }while(after!==null);assert.equal(count,144);
 await assert.rejects(()=>(kit.artifacts as any).scanFindings(user,artifact.body.sha256,{limit:37}));
 await assert.rejects(()=>kit.artifacts.acceptFindings(admin,artifact.body.sha256,values[142],{detectors:['password_assignment']}),/说明|命中/);
 await assert.rejects(()=>kit.artifacts.scanFindings(admin,artifact.body.sha256,{after:'malformed-cursor'}),/游标/);
 const first=await (kit.artifacts.acceptFindings as any)(admin,artifact.body.sha256,'合成示例核对',{detectors:['password_assignment']});assert.equal(first.complete,false);
 assert.equal((await kit.artifacts.source(user,artifact.body.sha256))?.bytes,null,'unaccepted bearer findings remain withheld');
 const last=await (kit.artifacts.acceptFindings as any)(admin,artifact.body.sha256,'合成示例核对',{detectors:['bearer_credential']});assert.equal(last.complete,true);
 assert.ok((await kit.artifacts.source(user,artifact.body.sha256))?.bytes);
 await kit.artifacts.revokeFindings(admin,artifact.body.sha256,'合成撤回核对');assert.equal((await kit.artifacts.source(user,artifact.body.sha256))?.bytes,null);
 await assert.rejects(()=>kit.artifacts.acceptFindings(admin,artifact.body.sha256,'合成自动重试',{detectors:['password_assignment','bearer_credential'],automatic:true}),/撤回/);
});

test('automatic and manual detector acceptance have distinct immutable audit receipts without values',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic administrator');
 for(const automatic of [false,true]){
  const artifact=await kit.artifacts.ingest({bytes:Buffer.from('password = SyntheticCredential'+(automatic?'A':'B')+'#72'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:'+String(automatic)}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  const accepted=await kit.artifacts.acceptFindings(admin,artifact.body.sha256,'合成示例接受',{detectors:['password_assignment'],automatic});
  const rows=await kit.store.find<any>({key:'authz.scan-accept.receipt',value:accepted.authorization.digest,kind:'action',limit:10});
  assert.equal(rows.items.length,1);assert.equal(rows.items[0].body.detail.automatic,automatic);assert.deepEqual(rows.items[0].body.detail.detectors,['password_assignment']);
  assert.ok(!JSON.stringify(rows.items).includes('SyntheticCredential'));assert.equal(rows.items[0].body.detail.administrator,admin.id);
 }
});
