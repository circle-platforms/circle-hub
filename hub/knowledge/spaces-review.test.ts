// Regression cases from the independent phase-2 security review; all bytes and accounts are synthetic.
import { withCredentialDetectors } from '../testing/records.ts';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { makeWorld, startPostgres, BASE_CATALOG, catalogXml } from './test-support.ts';
import { sha256Hex } from '../records/api.ts';
import { KnowledgeError } from './api.ts';
import { Database,createPool } from '../records/db.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
// Issue 194: these tests cover the holds and reviews of credential-scan@3, which records stored under it still follow.
withCredentialDetectors();
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

test('imports into a currently shared directory use the same complete credential inspection as grants',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  await spaces.directory(w.user,'/shared');await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});
  const opaque=[['synthetic.zip',Buffer.from(zipSync({'secret.txt':strToU8('DB_PASSWORD=hunter22x')})),'application/zip'],['synthetic.pdf',Buffer.from('%PDF-1.4\nsynthetic\n%%EOF'),'application/pdf'],['synthetic.png',Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),'image/png']] as const;
  for(const [name,bytes,type] of opaque){
    await assert.rejects(spaces.importFile(w.user,bytes,type,name,'/shared'),error=>error instanceof KnowledgeError&&error.code==='SPACE_CONTENT_UNINSPECTABLE',name);
    assert.equal(await w.kit.objects.has(sha256Hex(bytes)),false,'rejection happens before the bytes are saved');
    const stored=await spaces.importFile(w.user,bytes,type,name,'/private');assert.ok(stored);
  }
  await assert.rejects(spaces.grant(w.user,{path:'/private',audience:'member',member:w.outsider.id}),error=>error instanceof KnowledgeError&&error.code==='SPACE_CONTENT_UNINSPECTABLE');
  const secret=Buffer.from('DB_PASSWORD=hunter22x');
  await assert.rejects(spaces.importFile(w.user,secret,'text/plain','synthetic.txt','/shared'),error=>error instanceof KnowledgeError&&error.code==='SPACE_CREDENTIALS_DETECTED');
  assert.equal(await w.kit.objects.has(sha256Hex(secret)),false);
  const safe=await spaces.importFile(w.user,Buffer.from('合成可完整检查的文本'),'text/plain','safe.txt','/shared/child');
  assert.equal(Buffer.from((await spaces.source(w.outsider,safe.body.sha256))!.bytes!).toString(),'合成可完整检查的文本');
});

test('directory-only versions do not copy token documents or load unchanged entry bodies',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  const db=new Database(createPool(w.kit.database,1));t.after(()=>db.end());
  for(let i=0;i<5;i++)await spaces.write(w.user,{kind:'observation',statement:'合成稳定索引'+i,path:'/notes',data:{content:'合成内容'.repeat(1000)}});
  const before=(await db.query('SELECT count(*)::int AS n,sum(token_bytes)::text AS bytes FROM knowledge_space_search_documents')).rows[0];
  const records=new Set((await spaces.current(w.user.id))!.body.entries.map(row=>row.record));
  const original=w.kit.store.get.bind(w.kit.store);let loaded=0;
  w.kit.store.get=async(digest,tx)=>{if(records.has(digest))loaded++;return original(digest,tx);};
  for(let i=0;i<5;i++)await spaces.directory(w.user,'/empty-'+i);
  assert.deepEqual((await db.query('SELECT count(*)::int AS n,sum(token_bytes)::text AS bytes FROM knowledge_space_search_documents')).rows[0],before);
  assert.equal(loaded,0,'unchanged contents are not canonicalized or tokenized again');
  assert.equal((await spaces.search(w.user,'稳定索引','personal')).matches.length,5);
});

test('an import whose complete next snapshot exceeds capacity leaves no source bytes or artifact record',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  await spaces.directory(w.user,'/'+ 'x'.repeat(7800));
  const previous=(await spaces.current(w.user.id))!;
  const bytes=Buffer.from('合成容量预检查原文'),hash=sha256Hex(bytes);
  await spaces.setCapacity(w.admin,w.user.id,previous.body.used_bytes+bytes.length+8192);
  await assert.rejects(spaces.importFile(w.user,bytes,'text/plain','synthetic.txt'),error=>error instanceof KnowledgeError&&error.code==='SPACE_CAPACITY_EXCEEDED');
  assert.equal((await spaces.current(w.user.id))?.root,previous.root);
  assert.equal(await w.kit.objects.has(hash),false);
  assert.equal(await w.kit.objects.get(hash),null);
  assert.deepEqual(await w.kit.artifacts.records(hash),[]);
});

test('ordinary and personal upload refusals each leave one safe audit after rollback or shared-path preflight',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
  await spaces.directory(w.user,'/shared');await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});
  for(const mode of ['ordinary','private','shared']){
    const value='hunter22x-'+mode,bytes=Buffer.from('DB_PASSWORD='+value),hash=sha256Hex(bytes),before=(await spaces.current(w.user.id))!.root;
    let refusal:unknown;
    try{
      if(mode==='ordinary')await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session:null,message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true}});
      else await spaces.importFile(w.user,bytes,'text/plain','synthetic.txt',mode==='shared'?'/shared':'/private');
    }catch(error){refusal=error;}
    assert.ok(refusal,mode);const expected=mode==='shared'?'SPACE_CREDENTIALS_DETECTED':'CREDENTIAL_IN_UPLOAD';
    assert.equal((refusal as {code:string}).code,expected);
    const actions=await w.kit.store.find<any>({key:'artifact.refused',value:hash,kind:'action'});assert.equal(actions.items.length,1,mode);
    assert.equal((refusal as {detail:{action:string}}).detail.action,actions.items[0].digest);
    assert.deepEqual(actions.items[0].body.codes,[expected]);assert.equal(actions.items[0].body.detail.uploader,w.user.id);
    assert.ok(!JSON.stringify(actions.items[0]).includes(value));assert.equal(await w.kit.objects.has(hash),false);assert.deepEqual(await w.kit.artifacts.records(hash),[]);
    assert.equal((await spaces.current(w.user.id))!.root,before);
  }
  const bytes=Buffer.from(zipSync({'synthetic.txt':strToU8('合成不可检查容器')})),hash=sha256Hex(bytes);
  await assert.rejects(spaces.importFile(w.user,bytes,'application/zip','synthetic.zip','/shared'),(error:any)=>error.code==='SPACE_CONTENT_UNINSPECTABLE');
  const actions=await w.kit.store.find<any>({key:'artifact.refused',value:hash,kind:'action'});assert.equal(actions.items.length,1);assert.deepEqual(actions.items[0].body.codes,['SPACE_CONTENT_UNINSPECTABLE']);assert.equal(await w.kit.objects.has(hash),false);
});

test('writes and grant revocation queue by space without waiting for another member',async t=>{
  const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,index=w.kit.spaceIndex!;
  for(const by of [w.user,w.outsider]){await spaces.ensure(by);await spaces.grant(by,{path:'/',audience:'administrators'});}
  let release!:()=>void,entered!:()=>void,revoked=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const add=index.add.bind(index);let blocked=false;
  index.add=async(...args)=>{if(!blocked&&args[1].some(row=>row.space===w.user.id)){blocked=true;entered();await gate;}return add(...args);};
  const write=spaces.write(w.user,{kind:'observation',statement:'合成排队写入'});await waiting;
  const same=spaces.grant(w.user,{path:'/',audience:'administrators',revoke:true}).then(()=>{revoked=true;});
  const independent=(async()=>{await spaces.directory(w.outsider,'/independent');await spaces.grant(w.outsider,{path:'/',audience:'administrators',revoke:true});})();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([independent,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('another member write/revoke waited on the blocked space')),5000);})]);
    assert.equal(revoked,false,'the same space retains ordered mutation');
  }finally{if(timer)clearTimeout(timer);release();await Promise.all([write,same,independent]);index.add=add;}
  assert.equal(revoked,true);assert.equal((await spaces.grants(w.outsider)).length,0);
});


test('withdrawing and replacing current entries release the index quota while old references remain readable',async t=>{
  const w=await makeWorld(postgres,{records:{limits:{maxEntryIndexBytes:180,maxSpaceIndexBytes:180}}});t.after(w.close);const spaces=w.knowledge.spaces!;
  const first=await spaces.write(w.user,{kind:'observation',statement:'合成索引甲',path:'/notes'});
  await assert.rejects(spaces.write(w.user,{kind:'observation',statement:'合成索引乙',path:'/notes'}),error=>error instanceof KnowledgeError&&error.code==='SPACE_INDEX_LIMIT'&&/当前版本/.test(error.message)&&/撤回或替换/.test(error.fix??''));
  const replacement=await spaces.write(w.user,{kind:'observation',statement:'合成索引乙',path:'/notes',replaces:first.entry});
  assert.ok(await spaces.entry(w.user,first.root,'/notes',first.entry),'replaced historical references still resolve');
  await spaces.withdraw(w.user,replacement.entry);
  const next=await spaces.write(w.user,{kind:'observation',statement:'合成索引丙',path:'/notes'});
  for(let i=0;i<10;i++)await spaces.directory(w.user,'/empty-'+i);
  assert.equal((await spaces.search(w.user,'索引','personal')).matches[0].entry,next.entry);
  await assert.rejects(spaces.write(w.user,{kind:'observation',statement:'abcdefghijklmnopqrstuvwxyz',path:'/large'}),error=>error instanceof KnowledgeError&&error.code==='SPACE_INDEX_LIMIT'&&/单条/.test(error.message)&&/缩短或拆分/.test(error.fix??''));
});

test('an over-limit product index leaves personal and team matches available with explicit partial-scope warnings',async t=>{
  const w=await makeWorld(postgres,{records:{limits:{maxEntryIndexBytes:1024,maxSpaceIndexBytes:400,maxProductIndexBytes:400}}});t.after(w.close);const spaces=w.knowledge.spaces!;
  await spaces.write(w.user,{kind:'observation',statement:'合成搜索个人观察',path:'/notes'});
  const source=await w.kit.artifacts.ingest({bytes:Buffer.from('合成团队原文'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:index'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false},readTier:'model_readable'});
  await spaces.write(w.admin,{kind:'observation',statement:'合成搜索团队观察',path:'/notes',grounds:[{reference:'src:'+source.body.sha256,quotation:'合成团队原文'}]},null,'team');
  const object='site:tree:Rel_ACME_1_2_15';w.external.set(object,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build:{name:'Rel_ACME_1_2_15',family:'ACME',line:'1.2',base:'Rel_ACME_1_2_15',platform:null,built_at:'2026-01-02T10:00:00.000Z',released_at:'2026-01-05T00:00:00.000Z',sources:{tree:object},root:null}});
  assert.equal(produced.ok,true,produced.reason??'');assert.ok(produced.root);
  await w.knowledge.moveRoot(w.product.product.id,'1.2',null,produced.root,produced.action,{by:w.admin});
  await spaces.ensure(w.user,'team');await spaces.indexRound();
  for(const scope of ['all','team'] as const){
    const found=await spaces.search(w.user,'合成搜索',scope);
    assert.ok(found.matches.some(hit=>hit.statement==='合成搜索团队观察'));
    assert.equal(found.matches.some(hit=>hit.statement==='合成搜索个人观察'),scope==='all');
    assert.equal(found.warnings?.length,1);assert.equal(found.warnings[0].code,'SPACE_INDEX_LIMIT');
    assert.match(found.warnings[0].path??'',/^\/产品\//);assert.match(found.warnings[0].message,/未检索/);
  }
  const found=await spaces.search(w.user,'合成搜索','personal');assert.equal(found.matches.length,1);assert.equal(found.warnings,undefined);
  const index=w.kit.spaceIndex!,states=index.states.bind(index);
  index.states=async scopes=>scopes.map(()=>({ready:false,refused:null}));
  try{const unavailable=await spaces.search(w.user,'合成搜索','personal');assert.deepEqual(unavailable.matches,[]);assert.equal(unavailable.warnings?.[0].code,'SOURCE_UNAVAILABLE');assert.match(unavailable.warnings[0].message,/未检索/);}
  finally{index.states=states;}
});
