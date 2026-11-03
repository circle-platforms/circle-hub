// Decision 140 block 2: real loopback Hub, synthetic originals, sessions and current access checks.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {createTestHub} from '../../hub/server/testing-real.ts';
import {openConsole,type ConsoleClient} from './support/console.ts';
import {wordingProblems} from '../../hub/server/console/testing-wording.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
const original=(sha256:string,artifact:string)=>'/console/knowledge/source?'+new URLSearchParams({sha256,artifact});
const download=(sha256:string,artifact:string)=>'/console/knowledge/download?'+new URLSearchParams({sha256,artifact});
test('an owner, a folder grantee and a team reader follow listed original links to the same readable detail',async()=>{
 const hub=await createTestHub(options);try{
  const owner=await hub.createUser('合成列表作者'),grantee=await hub.createUser('合成列表读者'),spaces=hub.hub.knowledge.spaces!,author=await openConsole(hub,owner.token),reader=await openConsole(hub,grantee.token);
  await spaces.importFile(owner.principal,Buffer.from('合成列表目标正文'),'text/plain','合成列表目标.txt','/方法/认证');
  for(let n=0;n<35;n++)await spaces.importFile(owner.principal,Buffer.from('合成列表分页 '+n),'text/plain','合成列表分页 '+n+'.txt','/分页');
  await spaces.grant(owner.principal,{path:'/方法/认证',audience:'member',member:grantee.user.id});
  const team=await hub.records.artifacts.ingest({bytes:Buffer.from('合成团队列表正文'),mediaType:'text/plain',name:'合成团队列表.txt',origin:{read:{object:'synthetic:record:listed-original'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  await spaces.archiveSource(hub.admin.principal,{artifact:team.digest,message:'archive:'+team.digest,space:'team',path:'/团队原文'});
  const follow=async(web:ConsoleClient,path:string,name:string,text:string)=>{
   let listing=await web.get(path);assert.equal(listing.status,200);let row:string|undefined;
   for(let page=0;page<3;page++){
    row=[...listing.body.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(match=>match[0]).find(row=>row.includes(name));if(row)break;
    const next=[...listing.body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find(match=>match[2]==='下一页');assert.ok(next,'the target must be reachable through the rendered list pagination');listing=await web.get(next[1].replaceAll('&amp;','&'));assert.equal(listing.status,200);
   }
   assert.ok(row,'the authorized original is listed');const href=/href="([^"]+)"/.exec(row)?.[1]?.replaceAll('&amp;','&');assert.ok(href);assert.equal(new URL(href,hub.url).searchParams.get('view'),'sources');
   const detail=await web.get(href);assert.equal(detail.status,200,href);assert.doesNotMatch(detail.body,/该内容不存在或无权查看|Hub 内部错误/);assert.match(detail.body,/data-inspector-content/);assert.ok(detail.body.includes(name));assert.ok(detail.body.includes(text));assert.deepEqual(wordingProblems(detail.body),[]);
  };
  await follow(author,'/console/knowledge?view=sources&scope=personal','合成列表目标.txt','合成列表目标正文');
  await follow(author,'/console/knowledge?'+new URLSearchParams({view:'sources',scope:'personal',space:owner.user.id,path:'/方法/认证'}),'合成列表目标.txt','合成列表目标正文');
  await follow(reader,'/console/knowledge?view=sources&scope=shared','合成列表目标.txt','合成列表目标正文');
  await follow(reader,'/console/knowledge?view=sources&scope=team','合成团队列表.txt','合成团队列表正文');
 }finally{await hub.close();}
});
test('explicit source saving is protected and idempotent; four synthetic original forms browse through space permissions',async()=>{
 const hub=await createTestHub(options);try{
  const member=await hub.createUser('合成归档成员'),peer=await hub.createUser('合成归档读者'),spaces=hub.hub.knowledge.spaces!,web=await openConsole(hub,member.token),admin=await openConsole(hub,hub.admin.token),reader=await openConsole(hub,peer.token);
  const ordinary=await hub.records.artifacts.ingest({bytes:Buffer.from('合成普通任务原文'),mediaType:'text/plain',name:'合成任务文件.txt',origin:{upload:{session:'synthetic-archive-session'}},author:{user:member.user.id},provenanceType:'declared',visibility:{readers:[member.user.id],admins:true,packs:[],shareable:true}}),before=await hub.records.store.get(ordinary.digest);
  const empty=await web.get('/console/knowledge?view=sources');assert.equal(empty.status,200);assert.match(empty.body,/导入原文…/);assert.equal(await spaces.current(member.user.id),null);
  const source=await web.get(original(ordinary.body.sha256,ordinary.digest)+'#save-original');assert.equal(source.status,200);assert.equal(await spaces.current(member.user.id),null);assert.deepEqual(wordingProblems(source.body),[]);
  const fields={artifact:ordinary.digest,message:'archive:'+ordinary.digest,space:member.user.id,path:'/归档',csrf:csrf(source.body)};
  assert.equal((await web.post('/console/knowledge/do/save-source',{...fields,csrf:'wrong'})).status,403);
  assert.equal((await web.send('/console/knowledge/do/save-source',{method:'POST',headers:{origin:'https://192.0.2.8','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()})).status,403);
  assert.equal((await reader.post('/console/knowledge/do/save-source',{...fields,csrf:csrf((await reader.get('/console/overview')).body)})).status,404);
  const saved=await web.post('/console/knowledge/do/save-source',fields);assert.equal(saved.status,303);const version=(await spaces.current(member.user.id))!.root;assert.equal((await web.post('/console/knowledge/do/save-source',fields)).status,303);assert.equal((await spaces.current(member.user.id))!.root,version);assert.equal(await hub.records.artifacts.mayDeclareUpload(member.principal,ordinary.digest),true);assert.deepEqual(await hub.records.store.get(ordinary.digest),before);
  const html=await spaces.importFile(member.principal,Buffer.from('<h1>合成网页</h1><script>globalThis.archiveInjected=true</script>'),'text/html','合成网页快照.html','/归档');
  await spaces.importFile(member.principal,Buffer.from('合成用户：保留这段会话。\n合成助手：这只是原文摘录。'),'text/markdown','合成会话摘录.md','/归档');
  const business=await hub.records.artifacts.ingest({bytes:Buffer.from('{"合成记录":"只读结果"}'),mediaType:'application/json',name:'合成业务读取.json',origin:{read:{object:'synthetic:record:archive'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  const teamSource=await admin.get(original(business.body.sha256,business.digest));assert.match(teamSource.body,/保存到团队原文/);assert.equal((await admin.post('/console/knowledge/do/save-source',{artifact:business.digest,message:'archive:'+business.digest,space:'team',path:'/归档',csrf:csrf(teamSource.body)})).status,303);
  const listing=await web.get('/console/knowledge?view=sources');for(const name of ['合成任务文件.txt','合成网页快照.html','合成会话摘录.md','合成业务读取.json'])assert.ok(listing.body.includes(name));assert.deepEqual(wordingProblems(listing.body),[]);assert.doesNotMatch(listing.body,/<tr[^>]*>[\s\S]*?<button[\s\S]*?<\/tr>/);
  const escaped=await web.get(original(html.body.sha256,html.digest));assert.match(escaped.body,/&lt;script&gt;globalThis.archiveInjected=true&lt;\/script&gt;/);assert.doesNotMatch(escaped.body,/<script>globalThis.archiveInjected/);assert.deepEqual(wordingProblems(escaped.body),[]);
  await spaces.grant(member.principal,{path:'/归档',audience:'member',member:peer.user.id});const shared=await reader.get('/console/knowledge?view=sources&scope=shared');assert.match(shared.body,/合成网页快照.html/);assert.doesNotMatch((await reader.get('/console/knowledge?view=sources&scope=personal')).body,/合成网页快照.html/);
  await spaces.grant(member.principal,{path:'/归档',audience:'member',member:peer.user.id,revoke:true});assert.doesNotMatch((await reader.get('/console/knowledge?view=sources&scope=shared')).body,/合成网页快照.html/);assert.equal((await reader.get(original(html.body.sha256,html.digest))).status,404);
 }finally{await hub.close();}
});
test('opening a knowledge original loads server quotes, displays every match and locates a long tail without putting quotes in URLs',async()=>{
 const hub=await createTestHub(options);try{
  const member=await hub.createUser('合成定位成员'),web=await openConsole(hub,member.token),spaces=hub.hub.knowledge.spaces!;
  const raw='甲'.repeat(18000)+'\n'+Array.from({length:70},(_,n)=>'合成重复引文 '+n).join('\n'),file=await spaces.importFile(member.principal,Buffer.from(raw),'text/plain','合成长篇原文.txt');
  const entry=await spaces.write(member.principal,{kind:'observation',statement:'合成多处位置',grounds:[{reference:'src:'+file.body.sha256,quotation:'合成重复引文'}]});
  const detail=await web.get('/console/knowledge/space?'+new URLSearchParams({space:member.user.id,root:entry.root,path:'/',entry:entry.entry}));assert.match(detail.body,/多处匹配/);
  const href=/href="([^"]*\/console\/knowledge\/source\?[^"]*)"/.exec(detail.body)?.[1]?.replaceAll('&amp;','&');assert.ok(href);assert.ok(!href.includes(encodeURIComponent('合成重复引文')));assert.ok(href.includes('ground=0'));
  const page=await web.get(href);assert.equal(page.status,200);assert.match(page.body,/引文位置 · 70/);assert.match(page.body,/下一组/);assert.doesNotMatch(page.body,/<mark/);assert.deepEqual(wordingProblems(page.body),[]);
  const selected=await web.get(href+'&match=69&quotation='+encodeURIComponent('伪造引文'));assert.equal(selected.status,200);assert.match(selected.body,/<mark[^>]*>合成重复引文<\/mark>/);assert.match(selected.body,/70 \/ 70/);assert.deepEqual(wordingProblems(selected.body),[]);
  const second=await web.get(href+'&matchesOffset=32');assert.equal(second.status,200);assert.match(second.body,/33 \/ 70/);
  assert.equal((await web.get(href.replace('ground=0','ground=99'))).status,404);
  const unique=await spaces.write(member.principal,{kind:'observation',statement:'合成唯一位置',grounds:[{reference:'src:'+file.body.sha256,quotation:'合成重复引文 69'}]});
  const tail=await web.get(original(file.body.sha256,file.digest)+'&'+new URLSearchParams({root:unique.root,path:'/',entry:unique.entry,ground:'0'}));assert.match(tail.body,/已定位/);assert.match(tail.body,/<mark[^>]*>合成重复引文 69<\/mark>/);assert.ok(tail.body.length<100000);
  const bad=await spaces.write(member.principal,{kind:'observation',statement:'合成引用待重读',grounds:[{reference:'src:'+file.body.sha256,quotation:'合成重复引文 68'}]});
  const get=spaces.source.bind(spaces);spaces.source=async(...args)=>{const source=await get(...args);return source?.bytes?{...source,bytes:Buffer.from('合成已损坏原文')}:source;};
  const unresolved=await spaces.original(member.principal,{sha256:file.body.sha256,artifact:file.digest,root:bad.root,path:'/',entry:bad.entry,ground:0});assert.equal(unresolved.status,'unresolved');assert.equal(unresolved.window,null);spaces.source=get;
 }finally{await hub.close();}
});
test('attachments preserve exact bytes, remain non-executable and refuse revoked, withheld and corrupt captures',async()=>{
 const hub=await createTestHub(options);try{
  const member=await hub.createUser('合成下载成员'),peer=await hub.createUser('合成下载读者'),web=await openConsole(hub,member.token),reader=await openConsole(hub,peer.token),spaces=hub.hub.knowledge.spaces!;
  const bytes=Buffer.from([0x50,0x4b,0x03,0x04,0,255,0,128]),file=await spaces.importFile(member.principal,bytes,'application/zip','合成附件.zip','/下载');
  const reply=await fetch(hub.url+download(file.body.sha256,file.digest),{headers:{cookie:'circle_hub_session='+web.sessionCookie}});assert.equal(reply.status,200);assert.deepEqual(Buffer.from(await reply.arrayBuffer()),bytes);assert.match(reply.headers.get('content-disposition')??'',/^attachment;/);assert.equal(reply.headers.get('content-type'),'application/octet-stream');assert.equal(reply.headers.get('cache-control'),'no-store');assert.match(reply.headers.get('content-security-policy')??'',/sandbox/);assert.equal(reply.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await web.send(download(file.body.sha256,file.digest),{method:'POST'})).status,405);assert.equal((await web.send(download(file.body.sha256,file.digest),{headers:{origin:'https://192.0.2.8'}})).status,403);
  await spaces.grant(member.principal,{path:'/下载',audience:'member',member:peer.user.id}).then(()=>assert.fail('uninspectable binaries cannot be granted'),error=>assert.equal(error.code,'SPACE_CONTENT_UNINSPECTABLE'));
  const plain=await spaces.importFile(member.principal,Buffer.from('合成可撤回下载'),'text/plain','合成共享文本','/共享下载');await spaces.grant(member.principal,{path:'/共享下载',audience:'member',member:peer.user.id});assert.equal((await reader.get(download(plain.body.sha256,plain.digest))).status,200);
  await spaces.grant(member.principal,{path:'/共享下载',audience:'member',member:peer.user.id,revoke:true});const denied=await reader.get(download(plain.body.sha256,plain.digest)),missing=await reader.get(download('f'.repeat(64),'e'.repeat(64)));assert.equal(denied.status,404);assert.equal(missing.status,404);
  const nonces=[denied,missing].map(reply=>{const nonce=/script-src 'nonce-([^']+)'/.exec(String(reply.headers['content-security-policy']))?.[1];assert.ok(nonce);assert.ok(reply.body.includes('nonce="'+nonce+'"'),'the fresh nonce must match its actual CSP');return nonce;});assert.notEqual(nonces[0],nonces[1]);
  // Only the per-response CSP nonce varies; every content byte and refusal outcome must remain indistinguishable.
  assert.equal(denied.body.replaceAll('nonce="'+nonces[0]+'"','nonce="<response>"'),missing.body.replaceAll('nonce="'+nonces[1]+'"','nonce="<response>"'));assert.equal(String(denied.headers['content-security-policy']).replace(nonces[0],'<response>'),String(missing.headers['content-security-policy']).replace(nonces[1],'<response>'));assert.equal(denied.headers['content-disposition'],undefined);assert.equal(missing.headers['content-disposition'],undefined);
  for(const tier of ['retain_only','function_bytes_only']as const){const held=await hub.records.artifacts.ingest({bytes:Buffer.from('合成限制档位 '+tier),mediaType:'text/plain',origin:{upload:{session:'synthetic-held-'+tier}},author:{user:member.user.id},provenanceType:'declared',readTier:tier,visibility:{readers:[member.user.id],admins:true,packs:[],shareable:false}});assert.equal((await web.get(download(held.body.sha256,held.digest))).status,404);}
  const source=spaces.source.bind(spaces);spaces.source=async(...args)=>{const result=await source(...args);return result?.bytes?{...result,bytes:Buffer.from('synthetic-invalid-reader-bytes')}:result;};const inconsistent=await web.get(download(file.body.sha256,file.digest));assert.equal(inconsistent.status,500);assert.ok(!inconsistent.body.includes('synthetic-invalid-reader-bytes'));spaces.source=source;
  // Simulate offline corruption as the temporary database owner, never as the runtime role.
  const db=new pg.Client({...hub.records.database,ssl:false});await db.connect();try{
   await db.query('ALTER TABLE personal_payloads DISABLE TRIGGER USER');await db.query('ALTER TABLE personal_payloads DROP CONSTRAINT personal_payloads_check');
   await db.query('UPDATE personal_payloads SET data=$1 WHERE owner=$2 AND sha256=$3',[Buffer.from('synthetic-corruption'),member.user.id,file.body.sha256]);
   const corrupt=await web.get(download(file.body.sha256,file.digest));assert.equal(corrupt.status,500);assert.ok(!corrupt.body.includes('synthetic-corruption'));
   await db.query('UPDATE personal_payloads SET data=$1 WHERE owner=$2 AND sha256=$3',[bytes,member.user.id,file.body.sha256]);
  }finally{await db.query("ALTER TABLE personal_payloads ADD CONSTRAINT personal_payloads_check CHECK (encode(sha256(data),'hex')=sha256)");await db.query('ALTER TABLE personal_payloads ENABLE TRIGGER USER');await db.end();}
 }finally{await hub.close();}
});
