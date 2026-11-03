// Native personal knowledge/memory and portable revisions meet only inside the same owner/epoch transaction.
import {z} from 'zod';
import {PersonalSyncObject,PersonalSyncCommit,PERSONAL_SYNC_LIMITS,type PersonalSyncProjection,type PersonalSyncVerification} from '../../../contracts/src/sync.ts';
import {encodePersonalSyncObject,decodePersonalSyncObject} from '../../../contracts/src/sync-canonical.ts';
import {SpaceEntryBody,SpaceSourceBody} from '../../../contracts/src/spaces.ts';
import {MemoryVersionBody} from '../../../contracts/src/memory.ts';
import {PersonalPackVersionBody} from '../../../contracts/src/sharing.ts';
import {SyncObjectKindSchema,SyncModeSchema,KnowledgeEntryStatusSchema,ReadTierSchema,type SyncObjectKind} from '../../../contracts/generated/vocabulary.ts';
import {PROTOCOL_CODES,type ProtocolCode} from '../../../contracts/generated/protocol.ts';
import {canonicalize,sha256Hex,scanForCredentials,CREDENTIAL_SCANNER,RecordsError,type Principal,type Transaction,type PersonalSyncStore,type SourceArtifact,type PurgeRequester,type PurgePending} from '../../records/api.ts';
import {pathOf,pathSegments,parseReference,ReferenceSyntaxError,resolveReference,verifyQuote,type SourceRead} from '../../refs/api.ts';
import type {KnowledgeContext} from '../context.ts';
import type {KnowledgeSpaces,SpaceVersion} from '../spaces.ts';
import type {MemoryDocuments} from '../memory.ts';
import {SyncGraph,syncKey,type SyncItem} from './graph.ts';
const kinds=SyncObjectKindSchema.enum;
const hash=(v:unknown)=>sha256Hex(canonicalize(v));
const fail=(code:ProtocolCode='SYNC_OBJECT_INVALID'):never=>{throw new RecordsError(PROTOCOL_CODES[code].when,{code});};
const normalized=(input:unknown)=>{const bytes=encodePersonalSyncObject(input),id=sha256Hex(bytes);return {id,object:decodePersonalSyncObject(bytes,id)};};
type Verification=z.infer<typeof PersonalSyncVerification>;
type Binding=Awaited<ReturnType<PersonalSyncStore['bindings']>>[number];
type SourceRevision=Extract<PersonalSyncObject,{kind:'source_revision'}>;
type EntryRevision=Extract<PersonalSyncObject,{kind:'entry_revision'}>;
type MemoryRevision=Extract<PersonalSyncObject,{kind:'memory_revision'}>;
export class PersonalKnowledgeSync{
 readonly #ctx:KnowledgeContext;readonly #spaces:KnowledgeSpaces;readonly #memory:MemoryDocuments;readonly transport:PersonalSyncStore;
 constructor(ctx:KnowledgeContext,spaces:KnowledgeSpaces,memory:MemoryDocuments,transport:PersonalSyncStore){this.#ctx=ctx;this.#spaces=spaces;this.#memory=memory;this.transport=transport;}
 modeCheck(by:Principal,input:unknown){return this.transport.modeCheck(by,input);}
 changeMode(by:Principal,input:unknown):Promise<Exclude<Awaited<ReturnType<PersonalSyncStore['changeMode']>>,PurgePending>>;
 changeMode(by:Principal,input:unknown,via:PurgeRequester|undefined):Promise<Awaited<ReturnType<PersonalSyncStore['changeMode']>>|PurgePending>;
 changeMode(by:Principal,input:unknown,via?:PurgeRequester){return via?this.transport.changeMode(by,input,via):this.transport.changeMode(by,input);}
 #graph(by:Principal,epoch:string,tx:Transaction){return new SyncGraph(id=>this.transport.object(by,epoch,id,tx));}
 async state(by:Principal){const state=await this.transport.state(by);if(state.mode===SyncModeSchema.enum.local)return state;return this.transport.transact(by,state.epoch,async(scope,tx)=>{await this.#refresh(by,scope.epoch,tx);return this.transport.state(by,tx);});}
 async openSession(by:Principal,input:unknown){const request=z.object({epoch:z.uuid()}).parse(input);return this.transport.transact(by,request.epoch,async(scope,tx)=>{await this.#refresh(by,scope.epoch,tx);return this.transport.openSession(by,input,tx);});}
 async #refresh(by:Principal,epoch:string,tx:Transaction){
  const api=this.transport,head=await api.head(by,epoch,tx),fingerprint=await api.fingerprint(by,epoch,tx);if(head.native_state===fingerprint)return;
  const current=await this.#spaces.current(by.id,tx),memories=await this.#ctx.records.memoryIndex?.heads(by.id,tx)??[],packs=await this.#ctx.records.store.findMany({kind:'personal_pack_version',key:'personal.pack.owner',values:[by.id]},tx);
  if(!current&&!memories.length&&!packs.length&&!head.snapshot)return;
  const graph=this.#graph(by,epoch,tx),items=new Map((await graph.items(head.snapshot as string|null)).map(i=>[syncKey(i),i])),seen=new Set<string>();
  const priorConflicts=(head.snapshot?await api.note(by,epoch,'conflicts',String(head.snapshot),tx):[]) as Array<{item_id:string;heads:string[]}>|null,conflictedIds=new Set((priorConflicts??[]).map(c=>c.item_id));for(const row of items.values())if(row.heads.length>1)conflictedIds.add(row.item_id);
  const bindings=await api.bindings(by,epoch,tx),objects:PersonalSyncObject[]=[],added=new Map<string,PersonalSyncObject>();
  const add=(value:unknown)=>{const n=normalized(value);if(!added.has(n.id)){objects.push(n.object);added.set(n.id,n.object);}return n.id;};
  const get=async(id:string)=>added.get(id)??graph.get(id);
  const stable=async(kind:SyncObjectKind,identity:string)=>api.stableItem(by,kind as Parameters<PersonalSyncStore['stableItem']>[1],identity,tx);
  const emit=async(kind:SyncObjectKind,item_id:string,data:Record<string,unknown>,native:string,locator:string,historical=false)=>{
   const key=syncKey({kind,item_id}),row=items.get(key);let id:string|undefined;
   const previous=bindings.find(b=>b.kind===kind&&b.item_id===item_id&&b.native===native&&b.locator===locator);
   if(previous){const object=await get(previous.object_id);if('parents'in object.body){const {parents:ignored,...body}=object.body;if(canonicalize(body)===canonicalize({item_id,...data}))id=previous.object_id;}}
   if(!id&&row?.heads.length===1){const object=await get(row.heads[0]);if(object.kind===kind&&'parents'in object.body){const {parents:ignored,...body}=object.body;if(canonicalize(body)===canonicalize({item_id,...data}))id=row.heads[0];}}
   id??=add({schema:'personal-sync-object@1',kind,body:{item_id,...data,parents:historical||conflictedIds.has(item_id)?[]:row?.heads??[]}});
   const binding={kind,item_id,object_id:id,native,locator};bindings.push(binding);await api.bindings(by,epoch,tx,binding);
   if(!historical){items.set(key,{kind,item_id,heads:conflictedIds.has(item_id)?[...new Set([...row?.heads??[],id])].sort():[id]});seen.add(key);}return id;
  };
  const directories=new Map<string,string>();
  const directory=async(path:string):Promise<string>=>{if(directories.has(path))return directories.get(path)!;const bound=bindings.find(b=>b.kind===kinds.directory_revision&&b.native===sha256Hex(path));const id=bound?.item_id??await stable(kinds.directory_revision,'directory:'+path);directories.set(path,id);
   const parts=pathSegments(path),parent=parts.length?await directory(pathOf(parts.slice(0,-1))):null;await emit(kinds.directory_revision,id,{parent_directory:parent,name:parts.at(-1)??''},sha256Hex(path),'');return id;};
  await directory('/');for(const path of current?.body.directories??[])await directory(path);
  const byteObject=async(bytes:Uint8Array)=>{const object=normalized({schema:'personal-sync-object@1',kind:kinds.bytes,body:{bytes_base64:Buffer.from(bytes).toString('base64')}});await api.stage(by,epoch,[object.object],tx,true);return object.id;};
  const sourceObjects=new Map<string,string>();
  for(const digest of current?.body.sources??[]){const record=await this.#ctx.records.store.get(digest,tx);if(record?.kind!=='knowledge_space_source')return fail();const body=SpaceSourceBody.parse(record.body);
   const original=await this.#ctx.records.artifacts.source(by,body.sha256,{record:body.artifact,consumer:'function'});if(!original)return fail('SOURCE_UNAVAILABLE');const originalBytes=original.bytes??await this.#ctx.records.objects.get(body.sha256);if(!originalBytes)return fail('SOURCE_UNAVAILABLE');
   const bound=bindings.find(b=>b.kind===kinds.source_revision&&b.native===digest),item=bound?.item_id??await stable(kinds.source_revision,'source:'+digest),chunks:string[]=[];
   const chunkBytes=Math.min(PERSONAL_SYNC_LIMITS.chunkBytes,Math.max(1,Math.floor((api.limits.object_bytes-256)*3/4)));
   for(let offset=0;offset<originalBytes.length;offset+=chunkBytes)chunks.push(await byteObject(originalBytes.subarray(offset,offset+chunkBytes)));
   const id=await emit(kinds.source_revision,item,{directory_id:await directory(body.path),name:body.name!==undefined?body.name:original.artifact.body.name??null,media_type:original.mediaType,raw_sha256:body.sha256,size:original.size,chunks},digest,sha256Hex(body.path));sourceObjects.set(body.sha256,id);
  }
  const exporting=new Set<string>(),exported=new Map<string,string>();
  const entry=async(recordId:string,path:string,version:SpaceVersion,historical=false):Promise<string>=>{
   if(exported.has(recordId))return exported.get(recordId)!;if(exporting.has(recordId))return fail();exporting.add(recordId);
   const record=await this.#ctx.records.store.get(recordId,tx);if(record?.kind!=='knowledge_space_entry')return fail();const body=SpaceEntryBody.parse(record.body);
   let previous=body.replaces,anchor=body.entry;const visited=new Set<string>();while(previous&&!visited.has(previous)){visited.add(previous);anchor=previous;const older=version.body.entries.find(r=>r.entry===previous);if(!older)break;const r=await this.#ctx.records.store.get(older.record,tx);previous=r?.kind==='knowledge_space_entry'?SpaceEntryBody.parse(r.body).replaces:null;}
   const bound=bindings.find(b=>b.kind===kinds.entry_revision&&b.native===recordId),item=bound?.item_id??await stable(kinds.entry_revision,'entry:'+anchor),grounds:EntryRevision['body']['grounds']=[];
   for(const ground of body.grounds){const quotation=await byteObject(Buffer.from(ground.quotation)),ref=parseReference(ground.reference);
    if(ref.scheme==='src'&&ref.parser&&ref.selector&&sourceObjects.has(ref.sha256))grounds.push({source:sourceObjects.get(ref.sha256)!,parser:ref.parser,selector:ref.selector,quotation});
    else if(ref.scheme==='tree'&&ref.entry){const referenced=await this.#spaces.version(ref.root),row=referenced?.body.entries.find(r=>r.entry===ref.entry&&r.path===ref.path);if(referenced?.body.space===by.id&&row&&!exporting.has(row.record))grounds.push({entry:await entry(row.record,row.path,referenced,true),quotation});else grounds.push({reference:ground.reference,quotation});}
    else grounds.push({reference:ground.reference,quotation});
   }
   const id=await emit(kinds.entry_revision,item,{directory_id:historical&&!directories.has(path)?directories.get('/')!:await directory(path),content:body.content,grounds},recordId,sha256Hex(path),historical);await api.note(by,epoch,'entry-location',id,tx,{root:version.root,path,entry:body.entry});exporting.delete(recordId);exported.set(recordId,id);return id;
  };
  for(const row of current?.body.entries??[])if(row.status===KnowledgeEntryStatusSchema.enum.verified||row.status===KnowledgeEntryStatusSchema.enum.unverified)await entry(row.record,row.path,current!);
  for(const head of memories){const record=await this.#ctx.records.store.get(head.version,tx);if(record?.kind!=='memory_version')return fail();const body=MemoryVersionBody.parse(record.body),text=body.markdown??(await this.#ctx.records.store.get<MemoryVersionBody>(body.content_version!,tx))?.body.markdown;if(text===null||text===undefined)return fail();
   const bound=bindings.find(b=>b.kind===kinds.memory_revision&&(b.native===head.version||b.locator===head.document)),item=bound?.item_id??await stable(kinds.memory_revision,'memory:'+head.document);await emit(kinds.memory_revision,item,{directory_id:await directory(body.path),title:body.title,markdown:text,state:body.state},head.version,head.document);
  }
  const latestPacks=new Map<string,typeof packs[number]>();for(const pack of packs){const body=PersonalPackVersionBody.parse(pack.body);latestPacks.set(body.pack,pack);}
  for(const pack of latestPacks.values()){const body=PersonalPackVersionBody.parse(pack.body),item=await stable(kinds.pack_manifest,'pack:'+body.pack);await emit(kinds.pack_manifest,item,{manifest:body.manifest},pack.digest,'');}
  for(const [key,item]of items)if(!seen.has(key)&&!conflictedIds.has(item.item_id)&&item.heads.length===1){const object=await get(item.heads[0]);if(object.kind!==kinds.deletion&&bindings.some(b=>b.object_id===item.heads[0])&&item.kind!==kinds.pack_manifest){const id=add({schema:'personal-sync-object@1',kind:kinds.deletion,body:{item_id:item.item_id,parents:item.heads,target_kind:item.kind}});items.set(key,{...item,heads:[id]});}}
  const sorted=[...items.values()].sort((a,b)=>syncKey(a)<syncKey(b)?-1:1),pages:string[]=[];
  let bucket:SyncItem[]=[];
  const page=(values:SyncItem[])=>({schema:'personal-sync-object@1',kind:kinds.inventory_page,body:{items:values}});
  for(const row of sorted){if(bucket.length&&(bucket.length>=api.limits.page_items||encodePersonalSyncObject(page([...bucket,row])).byteLength>api.limits.object_bytes)){pages.push(add(page(bucket)));bucket=[];}bucket.push(row);}if(bucket.length)pages.push(add(page(bucket)));
  const snapshot=add({schema:'personal-sync-object@1',kind:kinds.snapshot,body:{parents:head.snapshot?[head.snapshot]:[],pages:pages.sort()}});
  const conflicts=sorted.filter(r=>r.heads.length>1||conflictedIds.has(r.item_id)).map(r=>({item_id:r.item_id,heads:r.heads,...(r.heads.length===1?{structural:true}:{})}));
  await api.stage(by,epoch,objects,tx,true);await api.note(by,epoch,'conflicts',snapshot,tx,conflicts);await api.checkpoint(by,epoch,snapshot,conflicts.length,tx);
 }
 /** `request` is the audited sync HTTP request; projected entries name it as their session. */
 async commit(by:Principal,session:string,raw:unknown,request_id:string|null=null){const parsed=PersonalSyncCommit.safeParse(raw);if(!parsed.success)return fail();const request=parsed.data;
  let mismatch:RecordsError|undefined;
  const result=await this.transport.transact(by,request.epoch,async(scope,tx)=>{await this.#refresh(by,scope.epoch,tx);
   try{return await this.transport.commit(by,session,request,()=>this.#apply(by,scope.epoch,request.snapshot,request.base_snapshot,request.operation_id,tx,request_id),tx);}
   catch(error){if(error instanceof RecordsError&&error.code==='SYNC_VERSION_CONFLICT'&&error.detail.state){mismatch=error;return null;}throw error;}
  });
  // A CAS mismatch must return a durable native export, never a snapshot rolled back with the rejected proposal.
  if(mismatch)throw mismatch;return result!;
 }
 async #apply(by:Principal,epoch:string,snapshot:string,base:string|null,operation:string,tx:Transaction,request_id:string|null=null){
  const api=this.transport,head=await api.head(by,epoch,tx),graph=this.#graph(by,epoch,tx);await graph.validate(snapshot);
  const previous=await graph.items(head.snapshot as string|null),items=await graph.items(snapshot);if(head.snapshot&&!graph.ancestor(String(head.snapshot),snapshot))return fail('SYNC_VERSION_CONFLICT');
  if(base&&head.snapshot&&!graph.ancestor(base,String(head.snapshot)))return fail('SYNC_VERSION_CONFLICT');graph.checkAdvance(previous,items);
  const rows=new Map(items.map(i=>[i.item_id,i])),paths=new Map<string,string>(),conflicted=new Set(items.filter(i=>i.heads.length>1).map(i=>i.item_id));
  const chosen=new Map<string,PersonalSyncObject>();for(const row of items)if(row.heads.length===1)chosen.set(row.item_id,await graph.get(row.heads[0]));
  const locating=new Set<string>();let root:string|null=null;
  const locate=async(id:string):Promise<string|null>=>{if(paths.has(id))return paths.get(id)!;if(conflicted.has(id))return null;if(locating.has(id))return fail();const object=chosen.get(id);if(!object||object.kind===kinds.deletion)return null;if(object.kind!==kinds.directory_revision)return fail();locating.add(id);const body=object.body;let path:string|null;
   if(body.parent_directory===null){if(body.name!==''||root&&root!==id)return fail();root=id;path='/';}
   else {if(!body.name||body.name==='.'||body.name==='..'||body.name.includes('/')||body.name.includes('\0'))return fail();const parent=await locate(body.parent_directory);if(parent===null){conflicted.add(id);if(rows.has(body.parent_directory))conflicted.add(body.parent_directory);else return fail();}path=parent===null?null:pathOf([...pathSegments(parent),body.name]);}
   locating.delete(id);if(path!==null)paths.set(id,path);return path;
  };
  for(const row of items)if(row.kind===kinds.directory_revision)await locate(row.item_id);
  const locations=new Map<string,string[]>();for(const [id,path]of paths){const siblings=locations.get(path)??[];siblings.push(id);locations.set(path,siblings);}for(const ids of locations.values())if(ids.length>1)for(const id of ids)conflicted.add(id);
  // A structural conflict suppresses the whole dependent subtree rather than selecting one directory.
  for(let n=0;n<items.length;n++){let changed=false;for(const [id,object]of chosen){const body=object.body,dependency='directory_id'in body?body.directory_id:object.kind===kinds.directory_revision?object.body.parent_directory:null;if(dependency&&conflicted.has(dependency)&&!conflicted.has(id)){conflicted.add(id);changed=true;}}if(!changed)break;}
  for(const [id,object]of chosen)if('directory_id'in object.body&&await locate(object.body.directory_id)===null){conflicted.add(id);if(rows.has(object.body.directory_id))conflicted.add(object.body.directory_id);else return fail();}
  if(items.length&&!root&&![...rows.values()].some(i=>i.kind===kinds.directory_revision&&conflicted.has(i.item_id)))return fail();
  const bindings=await api.bindings(by,epoch,tx),current=await this.#spaces.current(by.id,tx),originals=new Map<string,SourceArtifact>();
  for(const id of current?.body.sources??[]){const record=await this.#ctx.records.store.get(id,tx);if(record?.kind!=='knowledge_space_source')continue;const body=SpaceSourceBody.parse(record.body),artifact=await this.#ctx.records.store.get<SourceArtifact['body']>(body.artifact,tx);if(artifact?.kind==='source_artifact')originals.set(body.sha256,artifact as SourceArtifact);}
  const sourceData=new Map<string,{object:string;item_id:string;path:string;name:string|null;mediaType:string;size:number;sha256:string;readBytes:()=>Promise<Uint8Array>;privateOnly:boolean;original?:SourceArtifact}>(),sourceReads=new Map<string,()=>Promise<SourceRead>>();
  const source=async(id:string)=>{if(sourceData.has(id))return sourceData.get(id)!;const object=await graph.get(id);if(object.kind!==kinds.source_revision)return fail();const body=object.body;if(body.size>api.sourceBytes)return fail('SYNC_OBJECT_INVALID');
   const readBytes=async()=>{const bytes:Buffer[]=[];let size=0;for(const chunk of body.chunks){const part=await graph.get(chunk);if(part.kind!==kinds.bytes)return fail();const data=Buffer.from(part.body.bytes_base64,'base64');size+=data.length;if(size>body.size)return fail();bytes.push(data);}if(size!==body.size)return fail();const all=Buffer.concat(bytes,size);if(sha256Hex(all)!==body.raw_sha256)return fail('SYNC_OBJECT_HASH_MISMATCH');return all;};
   const all=await readBytes();
   const scan=scanForCredentials(all);if(scan.findings.length||scan.truncated)return fail('SPACE_CREDENTIALS_DETECTED');
   const directory=await locate(body.directory_id);
   const history=await this.#ctx.records.store.findMany({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[body.raw_sha256]},tx);
   const restrict=(artifact:SourceArtifact)=>('read'in artifact.body.origin&&!artifact.body.visibility.admins?4:artifact.body.read_tier===ReadTierSchema.enum.retain_only?3:artifact.body.read_tier===ReadTierSchema.enum.function_bytes_only?2:1);
   for(const record of history){const previous=SpaceSourceBody.parse(record.body);if(previous.space!==by.id)continue;const capture=await this.#ctx.records.store.get<SourceArtifact['body']>(previous.artifact,tx);if(capture?.kind==='source_artifact'){const old=originals.get(body.raw_sha256);if(!old||restrict(capture as SourceArtifact)>restrict(old))originals.set(body.raw_sha256,capture as SourceArtifact);}}
   const original=originals.get(body.raw_sha256);if(original&&original.body.media_type!==body.media_type)return fail('SYNC_OBJECT_INVALID');
   const data={object:id,item_id:body.item_id,path:directory??'/',name:body.name,mediaType:body.media_type,size:body.size,sha256:body.raw_sha256,readBytes,privateOnly:!scan.inspected||!!original&&(original.body.read_tier!==ReadTierSchema.enum.model_readable||'read'in original.body.origin&&!original.body.visibility.admins),original};sourceData.set(id,data);
   const row=rows.get(body.item_id);if(row?.heads.length===1&&row.heads[0]===id&&!conflicted.has(body.item_id)&&directory!==null)sourceReads.set(body.raw_sha256,async()=>original?((await this.#ctx.records.artifacts.source(by,body.raw_sha256,{record:original.digest}))??{bytes:null,size:body.size,mediaType:body.media_type,readTier:ReadTierSchema.enum.retain_only}):{bytes:scan.inspected?await readBytes():null,size:body.size,mediaType:body.media_type,readTier:scan.inspected?ReadTierSchema.enum.model_readable:ReadTierSchema.enum.retain_only});return data;
  };
  for(const item of items)if(item.kind===kinds.source_revision)for(const id of item.heads){const object=await graph.get(id);if(object.kind!==kinds.deletion)await source(id);}
  const observations:Verification[]=[],compiled=new Map<string,{status:SpaceEntryBody['status'];grounds:SpaceEntryBody['grounds'];shareable:boolean}>(),checking=new Set<string>();
  const verify=async(id:string):Promise<{status:SpaceEntryBody['status'];grounds:SpaceEntryBody['grounds'];shareable:boolean}>=>{
   if(compiled.has(id))return compiled.get(id)!;if(checking.has(id))return fail();checking.add(id);const object=await graph.get(id);if(object.kind!==kinds.entry_revision)return fail();const positions:Array<{ground:number;code:ProtocolCode}>=[],codes=new Set<ProtocolCode>(),grounds:SpaceEntryBody['grounds']=[];const parserLocks=new Map<string,string|null>();let lock:string|null=null,shareable=true;
   if(!object.body.grounds.length)codes.add('REFERENCE_UNRESOLVED');
   const addCode=(code:ProtocolCode,ground:number)=>{codes.add(code);positions.push({code,ground});};
   for(const [position,ground] of object.body.grounds.entries()){const quote=await graph.get(ground.quotation);if(quote.kind!==kinds.bytes)return fail();let quotation:string;try{quotation=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(quote.body.bytes_base64,'base64'));}catch{addCode('REFERENCE_UNRESOLVED',position);continue;}
    if('entry'in ground){const parent=await verify(ground.entry),entry=await graph.get(ground.entry);if(entry.kind!==kinds.entry_revision)return fail();if(parent.status!=='verified'||!entry.body.content.statement.includes(quotation)){addCode('REFERENCE_UNRESOLVED',position);shareable=false;}else shareable&&=parent.shareable;if(conflicted.has(entry.body.item_id)||!rows.has(entry.body.item_id))addCode('REFERENCE_UNRESOLVED',position);continue;}
    let reference:string;if('source'in ground){const data=await source(ground.source),revision=await graph.get(ground.source);if(revision.kind!==kinds.source_revision)return fail();const row=rows.get(revision.body.item_id);if(!row||row.heads.length!==1||row.heads[0]!==ground.source||conflicted.has(row.item_id)||await locate(revision.body.directory_id)===null)addCode('REFERENCE_UNRESOLVED',position);reference='src:'+revision.body.raw_sha256+'/'+ground.parser+'/'+ground.selector;if(data.original&&'read'in data.original.body.origin&&!data.original.body.visibility.admins)shareable=false;}
    else reference=ground.reference;
    try{const ref=parseReference(reference);const parsers=ref.scheme==='src'&&ref.parser&&this.#ctx.parsers.forReference?await this.#ctx.parsers.forReference(ref.parser,{user:by.id,role:by.role}):this.#ctx.parsers;if(ref.scheme==='src'&&ref.parser){lock=parsers.get(ref.parser)?.skill_digest??null;parserLocks.set(ref.parser,lock);}
     if(ref.scheme==='src'&&ref.parser&&!parsers.get(ref.parser)){addCode('SOURCE_UNAVAILABLE',position);grounds.push({reference,quotation});shareable=false;continue;}
     const result=await resolveReference(reference,{reader:{user:by.id,role:by.role},parsers,trees:this.#spaces.treeReader(),sources:{read:async sha=>{const read=sourceReads.get(sha);return read?read():this.#spaces.source(by,sha);}}});
     if(verifyQuote(result,quotation)!==true)addCode(result.resolved?'REFERENCE_UNRESOLVED':result.code as ProtocolCode,position);
     if('reference'in ground&&!await this.#spaces.syncMayGrant(by,[reference]))shareable=false;
     grounds.push({reference,quotation});
    }catch(error){addCode(error instanceof ReferenceSyntaxError?'REFERENCE_UNRESOLVED':'SOURCE_RETRYABLE',position);shareable=false;}
   }
   const status=codes.size?KnowledgeEntryStatusSchema.enum.unverified:KnowledgeEntryStatusSchema.enum.verified,result={status,grounds,shareable};compiled.set(id,result);checking.delete(id);observations.push({object:id,status,rule_version:'1.0.0',scanner:CREDENTIAL_SCANNER,parser_lock:parserLocks.size>1&&[...parserLocks.values()].some(Boolean)?hash([...parserLocks].sort()):lock,positions,parser_locks:[...parserLocks].sort(([a],[b])=>a<b?-1:1).map(([parser,digest])=>({parser,digest})),codes:[...codes].sort(),checked_at:this.#ctx.now().toISOString()});return result;
  };
  for(const item of items)if(item.kind===kinds.entry_revision)for(const id of item.heads){const object=await graph.get(id);if(object.kind!==kinds.deletion)await verify(id);}
  const entries:Parameters<KnowledgeSpaces['syncProjection']>[1]['entries']=[],memories:Parameters<MemoryDocuments['syncProjection']>[2]=[];
  let reservedBytes=0,reservedDocuments=0;
  for(const row of items){
   if(row.kind===kinds.memory_revision&&conflicted.has(row.item_id)){let max=0;for(const id of row.heads){const object=await graph.get(id);if(object.kind===kinds.memory_revision){if(Buffer.byteLength(object.body.markdown)>this.#ctx.records.memoryIndex!.limits.documentBytes)return fail('MEMORY_DOCUMENT_LIMIT');const path=await locate(object.body.directory_id);max=Math.max(max,Buffer.byteLength(object.body.title+object.body.markdown)+(path===null?8000:Buffer.byteLength(path)));}}reservedBytes+=max;reservedDocuments++;}
   if(conflicted.has(row.item_id)||row.heads.length!==1)continue;const object=chosen.get(row.item_id)!;if(object.kind===kinds.deletion)continue;
   if(object.kind===kinds.entry_revision){const path=await locate(object.body.directory_id);if(path===null){conflicted.add(row.item_id);continue;}const check=compiled.get(row.heads[0])!;entries.push({object:row.heads[0],item_id:row.item_id,path,content:object.body.content,grounds:check.grounds,status:check.status,privateOnly:check.status==='unverified'||!check.shareable});}
   if(object.kind===kinds.memory_revision){const path=await locate(object.body.directory_id);if(path===null){conflicted.add(row.item_id);continue;}const bound=bindings.filter(b=>b.kind===kinds.memory_revision&&b.item_id===row.item_id).at(-1),same=bindings.find(b=>b.object_id===row.heads[0]&&b.kind===kinds.memory_revision);memories.push({item_id:row.item_id,object:row.heads[0],document:same?.locator??bound?.locator,version:same?.native,title:object.body.title,path,markdown:object.body.markdown,state:object.body.state});}
  }
  const duplicates=new Map<string,typeof entries>();for(const entry of entries){const key=entry.path+'\0'+hash(entry.content),list=duplicates.get(key)??[];list.push(entry);duplicates.set(key,list);}for(const list of duplicates.values())if(list.length>1)for(const row of list)conflicted.add(row.item_id);
  const before=await api.nativeBytes(by,epoch,tx),sourceRows=[...sourceData.values()].filter(s=>{const row=rows.get(s.item_id);return row?.heads.length===1&&row.heads[0]===s.object&&!conflicted.has(s.item_id);});
  const sourceRecords=new Map(bindings.filter(b=>b.kind===kinds.source_revision).map(b=>[b.object_id,b.native])),entryRecords=new Map(bindings.filter(b=>b.kind===kinds.entry_revision).map(b=>[b.object_id,b.native]));
  const locationsByObject=new Map<string,{root:string;path:string;entry:string}>();
  for(const id of compiled.keys()){const location=await api.note(by,epoch,'entry-location',id,tx) as {root:string;path:string;entry:string}|null;if(location)locationsByObject.set(id,location);}
  const projected=new Map<string,typeof entries[number]>(),pending=new Set(compiled.keys());let projection:Awaited<ReturnType<KnowledgeSpaces['syncProjection']>>|undefined;
  for(let level=0;pending.size&&level<65;level++){
   const ready:string[]=[];for(const id of pending){const object=await graph.get(id);if(object.kind!==kinds.entry_revision)return fail();if(object.body.grounds.every(g=>!('entry'in g)||locationsByObject.has(g.entry)))ready.push(id);}
   if(!ready.length)return fail('SYNC_OBJECT_INVALID');
   for(const id of ready){const object=await graph.get(id);if(object.kind!==kinds.entry_revision)return fail();const check=compiled.get(id)!,grounds=[...check.grounds];
    for(const ground of object.body.grounds)if('entry'in ground){const location=locationsByObject.get(ground.entry)!,quote=await graph.get(ground.quotation);if(quote.kind!==kinds.bytes)return fail();grounds.push({reference:'tree:'+location.root+location.path+'@'+location.entry,quotation:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(quote.body.bytes_base64,'base64'))});}
    projected.set(id,{record:entryRecords.get(id),object:id,item_id:object.body.item_id,path:await locate(object.body.directory_id)??'/',content:object.body.content,grounds,status:check.status,privateOnly:conflicted.has(object.body.item_id)||check.status==='unverified'||!check.shareable});pending.delete(id);
   }
   projection=await this.#spaces.syncProjection(by,{epoch,session:request_id,directories:[...paths].filter(([id])=>!conflicted.has(id)).map(([,path])=>path),entries:[...projected.values()],sources:sourceRows.map(s=>({...s,record:sourceRecords.get(s.object)}))},tx);
   for(const binding of projection.bindings){if(binding.kind===kinds.source_revision)sourceRecords.set(binding.object_id,binding.native);if(binding.kind===kinds.entry_revision){entryRecords.set(binding.object_id,binding.native);const row=projection.version.body.entries.find(r=>r.record===binding.native)!;const location={root:projection.version.root,path:row.path,entry:row.entry};locationsByObject.set(binding.object_id,location);await api.note(by,epoch,'entry-location',binding.object_id,tx,location);}}
  }
  if(pending.size)return fail('SYNC_BATCH_LIMIT');
  projection=await this.#spaces.syncProjection(by,{epoch,session:request_id,directories:[...paths].filter(([id])=>!conflicted.has(id)).map(([,path])=>path),entries:entries.filter(e=>!conflicted.has(e.item_id)).map(e=>({...projected.get(e.object)!,record:entryRecords.get(e.object)})),sources:sourceRows.map(s=>({...s,record:sourceRecords.get(s.object)}))},tx);
  const memoryBindings=await this.#memory.syncProjection(by,epoch,memories,{bytes:reservedBytes,documents:reservedDocuments},tx);await api.reserve(by,epoch,reservedBytes,reservedDocuments,tx);
  for(const binding of [...projection.bindings,...memoryBindings])await api.bindings(by,epoch,tx,binding);
  for(const [id,path]of paths){const row=rows.get(id);if(row&&!conflicted.has(id))await api.bindings(by,epoch,tx,{kind:kinds.directory_revision,item_id:id,object_id:row.heads[0],native:sha256Hex(path),locator:''});}
  const after=await api.nativeBytes(by,epoch,tx);await api.credit(by,epoch,hash({snapshot,before,native:await api.fingerprint(by,epoch,tx)}),after-before,tx);
  const conflicts=items.filter(i=>conflicted.has(i.item_id)).map(i=>({item_id:i.item_id,heads:i.heads,...(i.heads.length===1?{structural:true}:{})}));
  await api.note(by,epoch,'conflicts',snapshot,tx,conflicts);for(const observation of observations)await api.note(by,epoch,'verification',hash([operation,observation]),tx,observation);
  const projections:z.infer<typeof PersonalSyncProjection>[]=[];
  for(const binding of projection.bindings){const row=projection.version.body.entries.find(r=>r.record===binding.native);projections.push({kind:binding.kind as z.infer<typeof PersonalSyncProjection>['kind'],item_id:binding.item_id,object:binding.object_id,...(row?{reference:'tree:'+projection.version.root+row.path+'@'+row.entry}:{})});}
  for(const binding of memoryBindings)projections.push({kind:kinds.memory_revision,item_id:binding.item_id,object:binding.object_id,document:binding.locator,version:binding.native});
  const published=await this.#ctx.records.store.findMany({kind:'personal_pack_version',key:'personal.pack.owner',values:[by.id]},tx);
  for(const row of items)if(row.kind===kinds.pack_manifest&&row.heads.length===1&&!conflicted.has(row.item_id)){const object=await graph.get(row.heads[0]);if(object.kind!==kinds.pack_manifest)continue;let installed=false;for(const record of published){const body=PersonalPackVersionBody.parse(record.body);if(canonicalize(body.manifest)!==canonicalize(object.body.manifest))continue;const retirement=await this.#ctx.records.store.find({kind:'personal_pack_retirement',key:'personal.pack.retired',value:by.id+'/'+body.pack+'@'+body.version,limit:1},tx);installed=!retirement.items.length;if(installed)break;}projections.push({kind:kinds.pack_manifest,item_id:row.item_id,object:row.heads[0],installed});}
  for(const [id,path]of paths){const row=rows.get(id);if(row&&!conflicted.has(id))projections.push({kind:kinds.directory_revision,item_id:id,object:row.heads[0],reference:'tree:'+projection.version.root+path});}
  await api.checkpoint(by,epoch,snapshot,conflicts.length,tx);return {verification:observations,conflicts,projections};
 }
 async conflicts(by:Principal){const state=await this.state(by);if(state.mode===SyncModeSchema.enum.local||!state.snapshot)return [];return this.transport.transact(by,state.epoch,async(scope,tx)=>(await this.transport.note(by,scope.epoch,'conflicts',state.snapshot!,tx)??[]) as Array<{item_id:string;heads:string[]}>);}
}
