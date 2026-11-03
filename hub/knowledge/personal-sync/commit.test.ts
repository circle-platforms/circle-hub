import type {z} from 'zod';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {makeWorld,startPostgres} from '../test-support.ts';
import {encodePersonalSyncObject,personalSyncObjectId} from '../../../contracts/src/sync-canonical.ts';
import {PersonalSyncResult,type PersonalSyncObject} from '../../../contracts/src/sync.ts';
const pack=(object:unknown)=>({id:personalSyncObjectId(object),bytes_base64:Buffer.from(encodePersonalSyncObject(object)).toString('base64')});
const object=(kind:string,body:unknown)=>({schema:'personal-sync-object@1',kind,body});
let pg:Awaited<ReturnType<typeof startPostgres>>;before(async()=>{pg=await startPostgres();});after(()=>pg.stop());
async function session(w:Awaited<ReturnType<typeof makeWorld>>){const sync=w.knowledge.personalSync!,raw=sync.transport,state=await sync.state(w.user),client_id=randomUUID();await raw.registerClient(w.user,{client_id,name:'synthetic-client'});const session=await sync.openSession(w.user,{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:state.snapshot});return {sync,raw,state:session.state,session:session.session_id};}
async function upload(w:Awaited<ReturnType<typeof makeWorld>>,s:Awaited<ReturnType<typeof session>>,values:unknown[]){for(let n=0;n<values.length;n+=s.raw.limits.batch_objects)await s.raw.upload(w.user,s.session,{schema:'personal-sync-upload@1',epoch:s.state.epoch,operation_id:randomUUID(),objects:values.slice(n,n+s.raw.limits.batch_objects).map(pack)});}
function snapshot(items:Array<{kind:string;item_id:string;heads:string[]}>,parents:string[]=[]){const page=object('inventory_page',{items:[...items].sort((a,b)=>(a.kind+':'+a.item_id)<(b.kind+':'+b.item_id)?-1:1)});return {page,snapshot:object('snapshot',{parents:parents.sort(),pages:[personalSyncObjectId(page)]})};}

test('atomic commit publishes verified knowledge and memory together, preserving raw CRLF source and quote bytes',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await session(w),directory=randomUUID(),source=randomUUID(),entry=randomUUID(),memory=randomUUID();
 const raw=Buffer.from('\uFEFF合成原文\r\n每次保留两份。\r\n'),quote=Buffer.from('每次保留两份');
 const {sha256Hex}=await import('../../records/api.ts');const chunk=object('bytes',{bytes_base64:raw.toString('base64')}),quotation=object('bytes',{bytes_base64:quote.toString('base64')});
 const dir=object('directory_revision',{item_id:directory,parents:[],parent_directory:null,name:''});
 const src=object('source_revision',{item_id:source,parents:[],directory_id:directory,name:'synthetic.txt',media_type:'text/plain',raw_sha256:sha256Hex(raw),size:raw.length,chunks:[personalSyncObjectId(chunk)]});
 const fact=object('entry_revision',{item_id:entry,parents:[],directory_id:directory,content:{kind:'observation',statement:'合成保留两份  \n',data:{},applicability:null},grounds:[{source:personalSyncObjectId(src),parser:'text@1',selector:'l/2',quotation:personalSyncObjectId(quotation)}]});
 const memo=object('memory_revision',{item_id:memory,parents:[],directory_id:directory,title:'合成偏好',markdown:'合成记忆正文',state:'enabled'});
 const inventory=snapshot([{kind:'directory_revision',item_id:directory,heads:[personalSyncObjectId(dir)]},{kind:'source_revision',item_id:source,heads:[personalSyncObjectId(src)]},{kind:'entry_revision',item_id:entry,heads:[personalSyncObjectId(fact)]},{kind:'memory_revision',item_id:memory,heads:[personalSyncObjectId(memo)]}]);
 await upload(w,s,[chunk,quotation,dir,src,fact,memo,inventory.page,inventory.snapshot]);
 assert.equal((await w.knowledge.memory.items(w.user,'personal')).length,0);assert.equal(await w.knowledge.spaces!.current(w.user.id),null);
 const request={schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(inventory.snapshot)};
 const result=await s.sync.commit(w.user,s.session,request);PersonalSyncResult.parse(result);assert.equal(result.verification[0].status,'verified');assert.equal(result.conflicts.length,0);
 const current=await w.knowledge.spaces!.current(w.user.id);assert.equal(current?.body.entries.length,1);const view=await w.knowledge.spaces!.entry(w.user,current!.root,'/',current!.body.entries[0].entry);assert.equal(view?.row.status,'verified');assert.equal(view?.body.content.statement,'合成保留两份  \n');assert.equal(view?.body.grounds[0].quotation,quote.toString());
 assert.equal((await w.knowledge.memory.items(w.user,'personal')).length,1);assert.deepEqual(Buffer.from((await w.knowledge.spaces!.source(w.user,sha256Hex(raw)))!.bytes!),raw);
 assert.deepEqual(await s.sync.commit(w.user,s.session,request),result);assert.deepEqual(await s.raw.result(w.user,s.state.epoch,request.operation_id),result);
 assert.equal((await s.sync.state(w.user)).snapshot,result.state.snapshot);assert.ok(result.state.last_synced_at);
});
async function memoryBase(w:Awaited<ReturnType<typeof makeWorld>>){const s=await session(w),directory=randomUUID(),item=randomUUID(),dir=object('directory_revision',{item_id:directory,parents:[],parent_directory:null,name:''}),memory=object('memory_revision',{item_id:item,parents:[],directory_id:directory,title:'合成记忆',markdown:'合成共同原文',state:'enabled'}),rows=[{kind:'directory_revision',item_id:directory,heads:[personalSyncObjectId(dir)]},{kind:'memory_revision',item_id:item,heads:[personalSyncObjectId(memory)]}],v=snapshot(rows);
 await upload(w,s,[dir,memory,v.page,v.snapshot]);const request={schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)};const result=await s.sync.commit(w.user,s.session,request);return {...s,rows,directory,item,memory,result};}

test('CAS never overwrites an intervening writer; deterministic sibling heads stay unresolved until a child covers every head',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await memoryBase(w),initial=s.result.state;
 const branch=(text:string)=>object('memory_revision',{...(s.memory.body as object),parents:[personalSyncObjectId(s.memory)],markdown:text});
 const left=branch('合成甲修改'),right=branch('合成乙修改'),leftId=personalSyncObjectId(left),rightId=personalSyncObjectId(right);
 const proposed=(heads:string[],parents:string[])=>snapshot(s.rows.map(r=>r.item_id===s.item?{...r,heads:heads.sort()}:r),parents);
 const a=proposed([leftId],[initial.snapshot!]),b=proposed([rightId],[initial.snapshot!]);await upload(w,s,[left,right,a.page,a.snapshot,b.page,b.snapshot]);
 const request=(snap:unknown,state=initial)=>({schema:'personal-sync-commit@1',epoch:state.epoch,operation_id:randomUUID(),expected_state:state.state_version,base_snapshot:initial.snapshot,snapshot:personalSyncObjectId(snap)});
 const first=await s.sync.commit(w.user,s.session,request(a.snapshot));await assert.rejects(s.sync.commit(w.user,s.session,request(b.snapshot)),{code:'SYNC_VERSION_CONFLICT'});
 assert.equal((await s.sync.state(w.user)).snapshot,first.state.snapshot);
 const missing=proposed([rightId],[first.state.snapshot!]);await upload(w,s,[missing.page,missing.snapshot]);await assert.rejects(s.sync.commit(w.user,s.session,request(missing.snapshot,first.state)),{code:'SYNC_VERSION_CONFLICT'});
 const merged=proposed([rightId,leftId],[first.state.snapshot!,personalSyncObjectId(b.snapshot)]);await upload(w,s,[merged.page,merged.snapshot]);const conflict=await s.sync.commit(w.user,s.session,request(merged.snapshot,first.state));assert.equal(conflict.conflicts.length,1);assert.deepEqual(conflict.conflicts[0].heads,[leftId,rightId].sort());assert.equal(conflict.state.status,'conflicted');assert.equal(conflict.state.last_synced_at,first.state.last_synced_at);assert.equal((await w.knowledge.memory.items(w.user,'personal',true)).length,0);
 await w.knowledge.memory.rebuild(w.user);assert.equal((await w.knowledge.memory.items(w.user,'personal',true)).length,0,'rebuild must not resurrect a conflict candidate');
 const page=await w.knowledge.memory.query(w.user,{scope:'personal',for_session:true});assert.equal(page.memory_page?.conflict_count,1);
 const resolution=object('memory_revision',{...(left.body as object),parents:[leftId,rightId].sort(),markdown:'合成本人明确选择甲内容'}),resolved=proposed([personalSyncObjectId(resolution)],[conflict.state.snapshot!]);await upload(w,s,[resolution,resolved.page,resolved.snapshot]);
 const final=await s.sync.commit(w.user,s.session,request(resolved.snapshot,conflict.state));assert.equal(final.conflicts.length,0);assert.equal((await w.knowledge.memory.items(w.user,'personal',true)).length,1);
 const doc=(await w.knowledge.memory.items(w.user,'personal'))[0];assert.equal((await w.knowledge.memory.read(w.user,doc.document)).markdown,'合成本人明确选择甲内容');
 assert.equal((await s.sync.state(w.user)).used_bytes,final.state.used_bytes,'receipt includes its own charged metadata exactly once');
});

test('native console/MCP service writes change the CAS token and export stable identities without pretending to synchronize',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const spaces=w.knowledge.spaces!;
 const first=await spaces.write(w.user,{kind:'observation',statement:'合成原生条目',path:'/notes'});const memo=await w.knowledge.memory.write(w.user,{space:'personal',expected_version:null,title:'合成原生记忆',markdown:'合成偏好',client_key:'native-create'});
 const s=await session(w);assert.ok(s.state.snapshot);assert.equal(s.state.last_synced_at,null);
 const rows=async()=>{const root=await s.raw.object(w.user,s.state.epoch,(await s.sync.state(w.user)).snapshot!);assert.equal(root?.kind,'snapshot');const items=[];if(root?.kind==='snapshot')for(const id of root.body.pages){const page=await s.raw.object(w.user,s.state.epoch,id);if(page?.kind==='inventory_page')items.push(...page.body.items);}return items;};
 const before=await rows(),oldMemory=before.find(r=>r.kind==='memory_revision')!;
 await w.knowledge.memory.write(w.user,{space:'personal',document:memo.document,expected_version:memo.version,markdown:'合成原生更新',client_key:'native-edit'});
 const next=await s.sync.state(w.user);assert.notEqual(next.state_version,s.state.state_version);assert.notEqual(next.snapshot,s.state.snapshot);assert.equal(next.last_synced_at,null);
 const after=await rows(),changed=after.find(r=>r.kind==='memory_revision')!;assert.equal(changed.item_id,oldMemory.item_id);assert.notDeepEqual(changed.heads,oldMemory.heads);
 const view=await w.knowledge.memory.read(w.user,memo.document);await w.knowledge.memory.write(w.user,{space:'personal',document:memo.document,expected_version:view.current_version,markdown:'合成尚未导出的更新',client_key:'native-edit-again'});
 let mismatch:unknown;try{await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:s.state.snapshot});}catch(error){mismatch=error;}
 const refusal=mismatch as {code:string;detail:{state:{snapshot:string;state_version:string}}};assert.equal(refusal.code,'SYNC_VERSION_CONFLICT');assert.equal((await s.raw.object(w.user,s.state.epoch,refusal.detail.state.snapshot))?.kind,'snapshot','CAS refusal returns a committed, retrievable snapshot');assert.equal((await s.raw.state(w.user)).state_version,refusal.detail.state.state_version);
 assert.equal((await spaces.current(w.user.id))?.root,first.root);
});

test('a failed memory projection rolls back knowledge, indexes, native bindings, head and sync time; staged batches remain resumable',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await session(w),directory=randomUUID(),item=randomUUID(),dir=object('directory_revision',{item_id:directory,parents:[],parent_directory:null,name:''}),memo=object('memory_revision',{item_id:item,parents:[],directory_id:directory,title:'合成原子回滚',markdown:'合成尚未发表',state:'enabled'}),entry=object('entry_revision',{item_id:randomUUID(),parents:[],directory_id:directory,content:{kind:'observation',statement:'合成回滚条目',data:{},applicability:null},grounds:[]});
 const v=snapshot([{kind:'directory_revision',item_id:directory,heads:[personalSyncObjectId(dir)]},{kind:'memory_revision',item_id:item,heads:[personalSyncObjectId(memo)]},{kind:'entry_revision',item_id:(entry.body as {item_id:string}).item_id,heads:[personalSyncObjectId(entry)]}]);await upload(w,s,[dir,memo,entry,v.page,v.snapshot]);
 const {Database,createPool}=await import('../../records/db.ts'),db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 await db.query("CREATE FUNCTION synthetic_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.kind='memory_version' THEN RAISE EXCEPTION 'synthetic projection failure';END IF;RETURN NEW;END$$");await db.query('CREATE TRIGGER synthetic_sync_failure BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION synthetic_sync_failure()');
 const request={schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)};
 await assert.rejects(s.sync.commit(w.user,s.session,request),/synthetic projection failure/);assert.equal(await w.knowledge.spaces!.current(w.user.id),null);assert.equal((await w.knowledge.memory.items(w.user,'personal')).length,0);assert.equal((await s.sync.state(w.user)).snapshot,null);assert.equal(await s.raw.operation(w.user,s.state.epoch,request.operation_id),null);
 assert.deepEqual(await s.raw.missing(w.user,s.session,{epoch:s.state.epoch,objects:[request.snapshot]}),{missing:[]});await db.query('DROP TRIGGER synthetic_sync_failure ON records');assert.ok(await s.sync.commit(w.user,s.session,request));
});

test('unreadable personal references and absent references have the same verification and stay private under inherited grants',{timeout:60_000},async t=>{
 const w=await makeWorld(pg,{now:()=>new Date('2026-11-03T00:00:00.000Z')});t.after(w.close);const secret=await w.knowledge.spaces!.importFile(w.outsider,Buffer.from('合成另一成员原件'),'text/plain','private.txt','/private');
 const s=await session(w),directory=randomUUID(),dir=object('directory_revision',{item_id:directory,parents:[],parent_directory:null,name:''}),quote=object('bytes',{bytes_base64:Buffer.from('合成另一成员原件').toString('base64')}),entries=[secret.body.sha256,'0'.repeat(64)].map((sha,n)=>object('entry_revision',{item_id:randomUUID(),parents:[],directory_id:directory,content:{kind:'observation',statement:'合成无权依据 '+n,data:{},applicability:null},grounds:[{reference:'src:'+sha,quotation:personalSyncObjectId(quote)}]}));
 const v=snapshot([{kind:'directory_revision',item_id:directory,heads:[personalSyncObjectId(dir)]},...entries.map(e=>({kind:'entry_revision',item_id:(e.body as {item_id:string}).item_id,heads:[personalSyncObjectId(e)]}))]);await upload(w,s,[dir,quote,...entries,v.page,v.snapshot]);
 const result=await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)});assert.equal(result.verification.length,2);assert.deepEqual(result.verification[0].codes,result.verification[1].codes);assert.ok(result.verification.every(v=>v.status==='unverified'));
 const {Database,createPool}=await import('../../records/db.ts'),db=new Database(createPool(w.kit.database));t.after(()=>db.end());const count=async()=>Number((await db.query("SELECT count(*) FROM personal_sync_notes WHERE owner=$1 AND kind='verification'",[w.user.id])).rows[0].count);const observations=await count();const state=await s.raw.state(w.user);await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:state.epoch,operation_id:randomUUID(),expected_state:state.state_version,base_snapshot:state.snapshot,snapshot:state.snapshot});assert.equal(await count(),observations+2);
 const current=(await w.knowledge.spaces!.current(w.user.id))!;assert.equal(current.body.entries.length,2);
 await assert.rejects(w.knowledge.spaces!.grant(w.user,{path:'/',audience:'member',member:w.outsider.id}));assert.equal((await w.knowledge.spaces!.search(w.outsider,'合成无权依据','shared')).matches.length,0);
});

test('same-name directories are deterministic structural conflicts; cycles and omitted items are refused',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await session(w),root=randomUUID(),a=randomUUID(),b=randomUUID(),dirs=[object('directory_revision',{item_id:root,parents:[],parent_directory:null,name:''}),...([a,b].map(id=>object('directory_revision',{item_id:id,parents:[],parent_directory:root,name:'同名合成目录'})))];
 const rows=dirs.map(d=>({kind:'directory_revision',item_id:(d.body as {item_id:string}).item_id,heads:[personalSyncObjectId(d)]})),v=snapshot(rows);await upload(w,s,[...dirs,v.page,v.snapshot]);const request={schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)};
 const result=await s.sync.commit(w.user,s.session,request);assert.equal(result.conflicts.length,2);assert.ok(result.conflicts.every(c=>c.structural));assert.deepEqual((await w.knowledge.spaces!.current(w.user.id))?.body.directories,['/']);
 const cycle=object('directory_revision',{item_id:a,parents:[personalSyncObjectId(dirs[1])],parent_directory:a,name:'合成环'}),c=snapshot(rows.map(r=>r.item_id===a?{...r,heads:[personalSyncObjectId(cycle)]}:r),[result.state.snapshot!]);await upload(w,s,[cycle,c.page,c.snapshot]);await assert.rejects(s.sync.commit(w.user,s.session,{...request,operation_id:randomUUID(),expected_state:result.state.state_version,base_snapshot:result.state.snapshot,snapshot:personalSyncObjectId(c.snapshot)}),{code:'SYNC_OBJECT_INVALID'});
 await w.knowledge.memory.write(w.user,{space:'personal',expected_version:null,title:'合成无关记忆',markdown:'合成无关更新不能解除目录冲突',client_key:'after-structural-conflict'});const refreshed=await s.sync.state(w.user);assert.equal(refreshed.status,'conflicted');assert.equal((await s.sync.conflicts(w.user)).length,2);assert.equal(refreshed.last_synced_at,null);
});

test('same-clock commits preserve transport identity, charge receipts once and bind operation keys to requests',{timeout:60_000},async t=>{
 const w=await makeWorld(pg,{now:()=>new Date('2026-11-03T00:00:00.000Z')});t.after(w.close);const s=await memoryBase(w);
 const before=await s.raw.state(w.user),request={schema:'personal-sync-commit@1',epoch:before.epoch,operation_id:randomUUID(),expected_state:before.state_version,base_snapshot:before.snapshot,snapshot:before.snapshot};
 const first=await s.sync.commit(w.user,s.session,request);assert.equal(first.state.snapshot,before.snapshot);assert.equal(first.state.used_bytes,(await s.raw.state(w.user)).used_bytes);
 await assert.rejects(s.sync.commit(w.user,s.session,{...request,snapshot:'f'.repeat(64)}),{code:'IDEMPOTENCY_MISMATCH'});
 const other=await s.raw.state(w.outsider);assert.equal(await s.raw.result(w.outsider,other.epoch,request.operation_id),null);
});

test('all native writes include staged capacity and an admission started in a previous epoch cannot enter the fresh epoch',{timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const spaces=w.knowledge.spaces!,s=await session(w);
 const value=object('bytes',{bytes_base64:Buffer.from('合成暂存占用'.repeat(100)).toString('base64')});await upload(w,s,[value]);const used=(await s.raw.state(w.user)).used_bytes;
 await spaces.setCapacity(w.admin,w.user.id,used+1024);await assert.rejects(spaces.write(w.user,{kind:'observation',statement:'合成越额'.repeat(600),path:'/new'}),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal(await spaces.current(w.user.id),null);
 await spaces.setCapacity(w.admin,w.user.id,1024*1024);
 const artifact=await w.kit.artifacts.ingest({bytes:Buffer.from('合成并发原文'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
 const parser=w.knowledge.__context.parsers.get('text@1')!;let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);
 const get=w.knowledge.__context.parsers.get.bind(w.knowledge.__context.parsers);w.knowledge.__context.parsers.get=key=>key==='text@1'?{...parser,parseAsync:async(bytes,options)=>{entered();await resume;return parser.parse(bytes,options);}}:get(key);
 const pending=spaces.write(w.user,{kind:'observation',statement:'合成旧代次写入',grounds:[{reference:'src:'+artifact.body.sha256+'/text@1/l/1',quotation:'合成并发原文'}]});await waiting;
 await w.kit.personalPayloads!.purge(w.user,s.state.epoch);const local=await s.raw.state(w.user);await s.raw.resume(w.user,local.epoch,local.state_version);release();await assert.rejects(pending,{code:'SYNC_EPOCH_CHANGED'});assert.equal(await spaces.current(w.user.id),null);
});

test('fresh same-batch knowledge predecessors have real native grounds, not transport ids masquerading as roots', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await session(w),root=randomUUID(),sourceId=randomUUID(),parentId=randomUUID(),childId=randomUUID();
 const dir=object('directory_revision',{item_id:root,parents:[],parent_directory:null,name:''}),bytes=Buffer.from('合成原文每次保留两份。'),chunk=object('bytes',{bytes_base64:bytes.toString('base64')}),quote=object('bytes',{bytes_base64:Buffer.from('每次保留两份').toString('base64')}),{sha256Hex}=await import('../../records/api.ts');
 const source=object('source_revision',{item_id:sourceId,parents:[],directory_id:root,name:'synthetic.txt',media_type:'text/plain',raw_sha256:sha256Hex(bytes),size:bytes.length,chunks:[personalSyncObjectId(chunk)]});
 const parent=object('entry_revision',{item_id:parentId,parents:[],directory_id:root,content:{kind:'observation',statement:'合成每次保留两份',data:{},applicability:null},grounds:[{source:personalSyncObjectId(source),parser:'text@1',selector:'l/1',quotation:personalSyncObjectId(quote)}]});
 const child=object('entry_revision',{item_id:childId,parents:[],directory_id:root,content:{kind:'observation',statement:'合成后续规则',data:{},applicability:null},grounds:[{entry:personalSyncObjectId(parent),quotation:personalSyncObjectId(quote)}]});
 const values=[dir,source,parent,child],v=snapshot(values.map((o,n)=>({kind:o.kind,item_id:[root,sourceId,parentId,childId][n],heads:[personalSyncObjectId(o)]})));await upload(w,s,[...values,chunk,quote,v.page,v.snapshot]);
 const result=await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)});assert.ok(result.verification.every(v=>v.status==='verified'));
 const projection=result.projections!.find(p=>p.object===personalSyncObjectId(child))!;assert.ok(projection.reference?.startsWith('tree:'));
 const current=(await w.knowledge.spaces!.current(w.user.id))!;assert.equal(current.body.entries.length,2);
 const bodies=await Promise.all(current.body.entries.map(r=>w.kit.store.get<import('../../../contracts/src/spaces.ts').SpaceEntryBody>(r.record)));const stored=bodies.find(b=>b?.body.content.statement==='合成后续规则')!;assert.equal(stored.body.grounds.length,1);assert.ok(!stored.body.grounds[0].reference.includes(personalSyncObjectId(parent)));
 const {resolveReference,verifyQuote}=await import('../../refs/api.ts');const check=await resolveReference(stored.body.grounds[0].reference,{reader:{user:w.user.id,role:w.user.role},parsers:w.knowledge.__context.parsers,trees:w.knowledge.spaces!.treeReader()});assert.equal(verifyQuote(check,'每次保留两份'),true);
});

test('explicit deletion preserves history and a rebuild never restores the deleted memory', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await memoryBase(w),original=(await w.knowledge.memory.items(w.user,'personal'))[0];
 const deletion=object('deletion',{item_id:s.item,parents:[personalSyncObjectId(s.memory)],target_kind:'memory_revision'}),v=snapshot(s.rows.map(r=>r.item_id===s.item?{...r,heads:[personalSyncObjectId(deletion)]}:r),[s.result.state.snapshot!]);await upload(w,s,[deletion,v.page,v.snapshot]);
 await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.result.state.state_version,base_snapshot:s.result.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)});
 assert.equal((await w.knowledge.memory.items(w.user,'personal')).length,0);await w.knowledge.memory.rebuild(w.user);assert.equal((await w.knowledge.memory.items(w.user,'personal')).length,0);
 const historical=await w.knowledge.memory.read(w.user,original.document,original.version);assert.equal(historical.current_version,null);assert.equal(historical.auto_load_allowed,false);assert.equal(historical.markdown,'合成共同原文');await assert.rejects(w.knowledge.memory.read(w.outsider,original.document,original.version),{code:'SOURCE_UNAVAILABLE'});
});

test('conflict memory reserves the largest title-path-body and cannot bypass capacity through a native write or rebuild', {timeout:60_000},async t=>{
 const w=await makeWorld(pg,{records:{limits:{maxMemorySpaceBytes:100}}});t.after(w.close);const s=await memoryBase(w),old=personalSyncObjectId(s.memory);
 const left=object('memory_revision',{...(s.memory.body as object),parents:[old],markdown:'a'.repeat(60)}),right=object('memory_revision',{...(s.memory.body as object),parents:[old],markdown:'b'.repeat(50)}),heads=[personalSyncObjectId(left),personalSyncObjectId(right)].sort(),v=snapshot(s.rows.map(r=>r.item_id===s.item?{...r,heads}:r),[s.result.state.snapshot!]);await upload(w,s,[left,right,v.page,v.snapshot]);
 const request={schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.result.state.state_version,base_snapshot:s.result.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)};const result=await s.sync.commit(w.user,s.session,request);assert.equal(result.conflicts.length,1);
 await w.knowledge.memory.rebuild(w.user);const usage=await w.knowledge.memory.usage(w.user);assert.equal(usage.activeDocuments,1);assert.equal(usage.active,Buffer.byteLength('合成记忆'+'/'+'a'.repeat(60)));
 await assert.rejects(w.knowledge.memory.write(w.user,{space:'personal',title:'合成新增',markdown:'c'.repeat(40),expected_version:null,client_key:'over-reservation'}),{code:'MEMORY_SPACE_LIMIT'});
 const large=object('memory_revision',{...(s.memory.body as object),parents:heads,markdown:'d'.repeat(110)}),next=snapshot(s.rows.map(r=>r.item_id===s.item?{...r,heads:[personalSyncObjectId(large)]}:r),[result.state.snapshot!]);await upload(w,s,[large,next.page,next.snapshot]);await assert.rejects(s.sync.commit(w.user,s.session,{...request,operation_id:randomUUID(),expected_state:result.state.state_version,base_snapshot:result.state.snapshot,snapshot:personalSyncObjectId(next.snapshot)}),{code:'MEMORY_SPACE_LIMIT'});
});

test('two client sessions racing the same state have exactly one CAS winner and preserve the other staged branch', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await memoryBase(w),client_id=randomUUID();await s.raw.registerClient(w.user,{client_id,name:'synthetic-second-client'});const other=await s.sync.openSession(w.user,{client_id,epoch:s.state.epoch,known_state:s.result.state.state_version,base_snapshot:s.result.state.snapshot});
 const branches=['合成并发甲','合成并发乙'].map(markdown=>object('memory_revision',{...(s.memory.body as object),parents:[personalSyncObjectId(s.memory)],markdown})),proposals=branches.map(branch=>snapshot(s.rows.map(r=>r.item_id===s.item?{...r,heads:[personalSyncObjectId(branch)]}:r),[s.result.state.snapshot!]));await upload(w,s,[...branches,...proposals.flatMap(v=>[v.page,v.snapshot])]);
 const result=await Promise.allSettled(proposals.map((v,n)=>s.sync.commit(w.user,n?other.session_id:s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.result.state.state_version,base_snapshot:s.result.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)})));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);const failed=result.find(r=>r.status==='rejected')! as PromiseRejectedResult;assert.equal(failed.reason.code,'SYNC_VERSION_CONFLICT');assert.ok(failed.reason.detail.state);
 assert.deepEqual(await s.raw.missing(w.user,other.session_id,{epoch:s.state.epoch,objects:proposals.map(v=>personalSyncObjectId(v.snapshot))}),{missing:[]});
});

test('directory deletion versus a new descendant remains a visible structural conflict instead of dropping the descendant', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const s=await session(w),root=randomUUID(),parent=randomUUID(),child=randomUUID(),dirs=[object('directory_revision',{item_id:root,parents:[],parent_directory:null,name:''}),object('directory_revision',{item_id:parent,parents:[],parent_directory:root,name:'合成父目录'})],rows=dirs.map((d,n)=>({kind:'directory_revision',item_id:[root,parent][n],heads:[personalSyncObjectId(d)]})),base=snapshot(rows);await upload(w,s,[...dirs,base.page,base.snapshot]);
 const first=await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(base.snapshot)});
 const deletion=object('deletion',{item_id:parent,parents:[personalSyncObjectId(dirs[1])],target_kind:'directory_revision'}),addition=object('directory_revision',{item_id:child,parents:[],parent_directory:parent,name:'合成新增子目录'}),next=snapshot([rows[0],{...rows[1],heads:[personalSyncObjectId(deletion)]},{kind:'directory_revision',item_id:child,heads:[personalSyncObjectId(addition)]}],[first.state.snapshot!]);await upload(w,s,[deletion,addition,next.page,next.snapshot]);
 const second=await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:first.state.state_version,base_snapshot:first.state.snapshot,snapshot:personalSyncObjectId(next.snapshot)});assert.equal(second.conflicts.length,2);assert.ok(second.conflicts.every(c=>c.structural));assert.deepEqual((await w.knowledge.spaces!.current(w.user.id))!.body.directories,['/']);
});

test('unverified sync revisions under an existing directory grant are excluded before search pagination', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);await w.knowledge.spaces!.ensure(w.user);await w.knowledge.spaces!.grant(w.user,{path:'/',audience:'member',member:w.outsider.id});
 const s=await session(w),snapshotObject=await s.raw.object(w.user,s.state.epoch,s.state.snapshot!),baseRows=[];if(snapshotObject?.kind==='snapshot')for(const id of snapshotObject.body.pages){const page=await s.raw.object(w.user,s.state.epoch,id);if(page?.kind==='inventory_page')baseRows.push(...page.body.items);}const root=baseRows.find(r=>r.kind==='directory_revision')!;
 const quote=object('bytes',{bytes_base64:Buffer.from('合成错误引文').toString('base64')}),values=Array.from({length:3},(_,n)=>object('entry_revision',{item_id:randomUUID(),parents:[],directory_id:root.item_id,content:{kind:'observation',statement:'合成仅本人候选 '+n,data:{},applicability:null},grounds:[{reference:'src:'+'0'.repeat(64),quotation:personalSyncObjectId(quote)}]})),candidate=snapshot([...baseRows,...values.map(o=>({kind:o.kind,item_id:(o.body as {item_id:string}).item_id,heads:[personalSyncObjectId(o)]}))],[s.state.snapshot!]);await upload(w,s,[quote,...values,candidate.page,candidate.snapshot]);
 await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(candidate.snapshot)});
 const owner=await w.knowledge.spaces!.search(w.user,'合成仅本人候选','personal');assert.equal(owner.matches.length,3);
 const hidden=await w.knowledge.spaces!.search(w.outsider,'合成仅本人候选','shared',null,1),absent=await w.knowledge.spaces!.search(w.outsider,'合成确实不存在','shared',null,1);assert.deepEqual(hidden,{matches:[],next:null});assert.deepEqual(absent,hidden);
});

test('sync retains capture provenance and read tiers when renaming a source, and refuses a conflicting media type', {timeout:60_000},async t=>{
 const w=await makeWorld(pg);t.after(w.close);const spaces=w.knowledge.spaces!,bytes=Buffer.from('合成个人凭据来源内容');let capture!:import('../../records/api.ts').SourceArtifact;await spaces.directory(w.user,'/private');await spaces.directory(w.user,'/shared');await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});const empty=(await spaces.current(w.user.id))!;
 capture=await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',name:'synthetic.txt',origin:{read:{object:'synthetic:document:personal'}},author:{user:w.user.id},provenanceType:'observed',readTier:'function_bytes_only',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
 await w.kit.store.withTransaction(async tx=>{const source=await w.kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:w.user.id,path:'/private',sha256:capture.body.sha256,artifact:capture.digest,size:bytes.length,by:w.user.id,at:capture.created_at},index:[{key:'knowledge.space.source',value:w.user.id},{key:'knowledge.space.source_hash',value:capture.body.sha256}]},tx);
  await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{...empty.body,parent:empty.root,sources:[source.digest],reason:'synthetic private capture',used_bytes:bytes.length},index:[{key:'knowledge.space.version',value:w.user.id}]},tx);
 });
 const s=await session(w),graph=s.raw,root=await graph.object(w.user,s.state.epoch,s.state.snapshot!),rows=[];if(root?.kind==='snapshot')for(const id of root.body.pages){const page=await graph.object(w.user,s.state.epoch,id);if(page?.kind==='inventory_page')rows.push(...page.body.items);}
 const sourceRow=rows.find(r=>r.kind==='source_revision')!,original=await graph.object(w.user,s.state.epoch,sourceRow.heads[0]);assert.equal(original?.kind,'source_revision');if(original?.kind!=='source_revision')throw new Error('synthetic source not exported');
 let sharedDir='';for(const row of rows)if(row.kind==='directory_revision'){const object=await graph.object(w.user,s.state.epoch,row.heads[0]);if(object?.kind==='directory_revision'&&object.body.name==='shared')sharedDir=row.item_id;}assert.ok(sharedDir);
 const renamed=object('source_revision',{...original.body,directory_id:sharedDir,parents:sourceRow.heads,name:'synthetic-renamed.txt'}),v=snapshot(rows.map(r=>r.item_id===sourceRow.item_id?{...r,heads:[personalSyncObjectId(renamed)]}:r),[s.state.snapshot!]);await upload(w,s,[renamed,v.page,v.snapshot]);
 const first=await s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:s.state.state_version,base_snapshot:s.state.snapshot,snapshot:personalSyncObjectId(v.snapshot)}),current=(await spaces.current(w.user.id))!,link=await w.kit.store.get<z.infer<typeof import('../../../contracts/src/spaces.ts').SpaceSourceBody>>(current.body.sources[0]);assert.equal(link?.body.artifact,capture.digest);assert.equal(link?.body.name,'synthetic-renamed.txt');assert.equal((await spaces.source(w.user,capture.body.sha256))?.readTier,'function_bytes_only');assert.equal(await spaces.source(w.outsider,capture.body.sha256,undefined,'function'),null);assert.equal((await spaces.sources(w.outsider,w.user.id)).length,0);assert.deepEqual(await spaces.basisSources(w.outsider,current.root),[]);
 const changed=object('source_revision',{...original.body,parents:[personalSyncObjectId(renamed)],media_type:'application/json'}),next=snapshot(rows.map(r=>r.item_id===sourceRow.item_id?{...r,heads:[personalSyncObjectId(changed)]}:r),[first.state.snapshot!]);await upload(w,s,[changed,next.page,next.snapshot]);await assert.rejects(s.sync.commit(w.user,s.session,{schema:'personal-sync-commit@1',epoch:s.state.epoch,operation_id:randomUUID(),expected_state:first.state.state_version,base_snapshot:first.state.snapshot,snapshot:personalSyncObjectId(next.snapshot)}),{code:'SYNC_OBJECT_INVALID'});
});
