import {INITIAL_PERSONAL_EPOCH} from '../records/api.ts';
import {personalEpoch,guardPersonalEpoch} from './personal-sync/guard.ts';
// Memory is a versioned client preference, with its own grants and no evidence reference.
import {lockActive} from './active-account.ts';
import {historyUsage,requireCapacity} from './capacity.ts';
import {MemoryDocumentBody,MemoryVersionBody,MemoryGrantBody,MemoryShareBody,MemoryWriteInput,MemoryShareInput,MemoryQuery,MemoryWriteReceipt,type MemoryMetadata} from '../../contracts/src/memory.ts';
import {PROTOCOL_CODES,type ProtocolCode} from '../../contracts/generated/protocol.ts';
import {SyncObjectKindSchema,SyncModeSchema,ActionKindSchema,ShareCheckSchema,uiLabelOf,MemoryFieldSchema,type KnowledgeSearchScope,type KnowledgeGrantee} from '../../contracts/generated/vocabulary.ts';
import {withReadScope,scopedRecordStore,memoReadPort,canonicalize,sha256Hex,scanForCredentials,newId,type Principal,type StoredRecord,type RecordKind,type Transaction,type MemoryHead,type Page} from '../records/api.ts';
import {pathOf,pathSegments} from '../refs/api.ts';
import {KnowledgeError} from './errors.ts';
import {WriteQueue,type KnowledgeContext} from './context.ts';
import {withinSpacePath,type KnowledgeSpaces,type SharingCheck} from './spaces.ts';
const fail=(code:ProtocolCode,message=PROTOCOL_CODES[code].when):never=>{throw new KnowledgeError(message,{code});};
const digest=(value:unknown)=>sha256Hex(canonicalize(value));
const pathCheck=(value:string)=>{try{return pathOf(pathSegments(value));}catch{return fail('SUBMISSION_SCHEMA_VIOLATION');}};
const nextCursor=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
function cursor(raw:string|undefined,snapshot:string,mode:string):number{
 if(!raw)return 0;
 try{const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(value.snapshot===snapshot&&value.mode===mode&&Number.isSafeInteger(value.offset)&&value.offset>=0)return value.offset;}catch{}
 return fail('MEMORY_CURSOR_STALE');
}
export interface MemorySharingResult {ok:boolean;checks:SharingCheck[];effect:MemoryShareBody['effect'];replaces:string|null;title:string;target_path?:string;share?:MemoryShareBody;record?:string}
export class MemoryDocuments{
 #rawCtx:KnowledgeContext;#spaces:KnowledgeSpaces;#queues=new Map<string,WriteQueue>();
 constructor(ctx:KnowledgeContext,spaces:KnowledgeSpaces){this.#rawCtx=ctx;this.#spaces=spaces;}
 get #ctx():KnowledgeContext{
  const ctx=this.#rawCtx;
  return {...ctx,records:{...ctx.records,store:scopedRecordStore(ctx.records.store),principals:memoReadPort(ctx.records.principals,['get']),...(ctx.records.memoryIndex?{memoryIndex:memoReadPort(ctx.records.memoryIndex,['heads','usage'])}:{})}};
 }
 #index(){return this.#ctx.records.memoryIndex??fail('SOURCE_UNAVAILABLE');}
 #now(){return this.#ctx.now().toISOString();}
 async #user(by:Principal){const user=await this.#ctx.records.principals.get(by.id);return user&&!user.disabled?user:fail('SOURCE_UNAVAILABLE');}
 #queue<T>(space:string,work:()=>Promise<T>){let queue=this.#queues.get(space);if(!queue){queue=new WriteQueue();this.#queues.set(space,queue);}return queue.run(work);}
 async #all<B>(kind:RecordKind,key:string,value:string,tx?:Transaction){const rows:StoredRecord<B>[]=[];let next:string|null=null;do{const page:Page<StoredRecord<B>>=await this.#ctx.records.store.find<B>({kind,key,value,cursor:next,limit:500},tx);rows.push(...page.items);next=page.next;}while(next);return rows;}
 async #grants(owner:string,tx?:Transaction){const records=await this.#all('memory_grant','memory.grant.owner',owner,tx),latest=new Map<string,ReturnType<typeof MemoryGrantBody.parse>>();for(const row of records){const body=MemoryGrantBody.parse(row.body);if(body.space===owner&&body.by===owner)latest.set(canonicalize([body.path,body.audience,body.member]),body);}return [...latest.values()].filter(g=>g.action==='grant');}
 async grants(by:Principal){by=await this.#user(by);return this.#grants(by.id);}
 async #mayRead(by:Principal,space:string,path:string,tx?:Transaction){
  if(space==='team'||space===by.id)return true;
  const owner=await this.#ctx.records.principals.get(space);if(!owner||owner.disabled)return false;
  return (await this.#grants(space,tx)).some(g=>withinSpacePath(path,g.path)&&(g.audience==='member'?g.member===by.id:by.role==='admin'));
 }
 async #record(digest:string,tx?:Transaction){
  const record=await this.#ctx.records.store.get(digest,tx);
  // A batch miss can mean a missing active payload. Keep the scalar store's capsule integrity check before treating it as absence.
  return record??await this.#rawCtx.records.store.get(digest,tx);
 }
 async #version(head:MemoryHead,version=head.version,tx?:Transaction){
  const record=await this.#record(version,tx);if(record?.kind!=='memory_version')return fail('SOURCE_UNAVAILABLE');const body=MemoryVersionBody.parse(record.body);
  if(body.document!==head.document||body.space!==head.space)return fail('SOURCE_UNAVAILABLE');return {record,body};
 }
 async #text(body:MemoryVersionBody,tx?:Transaction):Promise<string>{
  if(body.markdown!==null)return body.markdown;
  const record=body.content_version?await this.#record(body.content_version,tx):null;
  if(record?.kind!=='memory_version')return fail('SOURCE_UNAVAILABLE');const source=MemoryVersionBody.parse(record.body);
  if(source.document!==body.document||source.space!==body.space||source.markdown===null||source.bytes!==body.bytes)return fail('SOURCE_UNAVAILABLE');return source.markdown;
 }
 #metadata(head:MemoryHead,body:MemoryVersionBody,version=head.version):MemoryMetadata{return {document:head.document,version,space:head.space,title:body.title,path:body.path,state:version===head.version?body.state:'superseded',bytes:body.bytes,updated_at:body.at,updated_by:body.by,auto_load_allowed:false};}
 #sessionLimits(heads:readonly MemoryHead[]){
  const active=heads.filter(head=>head.state==='enabled'),limits=this.#index().limits;
  if(active.some(head=>head.bytes>limits.documentBytes))return fail('MEMORY_DOCUMENT_LIMIT');
  if(active.length>limits.spaceDocuments||active.reduce((sum,head)=>sum+head.contextBytes,0)>limits.spaceBytes)return fail('MEMORY_SPACE_LIMIT');
 }
 items(by:Principal,scope:KnowledgeSearchScope='all',forSession=false):Promise<MemoryMetadata[]>{return withReadScope(()=>this.#items(by,scope,forSession));}
 async #items(by:Principal,scope:KnowledgeSearchScope,forSession:boolean):Promise<MemoryMetadata[]>{
  by=await this.#user(by);const ids=new Set<string>();if(scope==='all'||scope==='personal')ids.add(by.id);if(scope==='all'||scope==='team')ids.add('team');
  if(scope==='all'||scope==='shared')for(const record of await this.#ctx.records.store.findMany({kind:'memory_grant',key:'memory.grant.grantee',values:[by.id,...(by.role==='admin'?['administrators']:[])]})){const body=MemoryGrantBody.parse(record.body);if(body.space!==by.id)ids.add(body.space);}
  const items:MemoryMetadata[]=[];
  for(const space of ids){
   if(forSession&&space!==by.id&&space!=='team')continue;
   const heads=await this.#index().heads(space);if(forSession)this.#sessionLimits(heads);
   const rows=await Promise.all(heads.map(async head=>{
    if(!await this.#mayRead(by,space,head.path))return null;
    const {body}=await this.#version(head);if(space!==by.id&&!(space==='team'&&by.role==='admin')&&body.state!=='enabled')return null;
    const allowed=(space==='team'||space===by.id)&&body.state==='enabled';if(forSession&&!allowed)return null;
    return {...this.#metadata(head,body),auto_load_allowed:allowed};
   }));
   for(const row of rows)if(row)items.push(row);
  }
  by=await this.#user(by);for(let i=items.length-1;i>=0;i--)if(!await this.#mayRead(by,items[i].space,items[i].path))items.splice(i,1);
  return items.sort((a,b)=>a.document.localeCompare(b.document));
 }
 async read(by:Principal,document:string,version?:string,forSession=false){
  by=await this.#user(by);const doc=await this.#record(document);if(doc?.kind!=='memory_document')return fail('SOURCE_UNAVAILABLE');const identity=MemoryDocumentBody.parse(doc.body);
  const heads=await this.#index().heads(identity.space),head=heads.find(h=>h.document===document);
  if(!head&&version&&identity.space===by.id&&!forSession){const record=await this.#record(version);if(record?.kind!=='memory_version')return fail('SOURCE_UNAVAILABLE');const body=MemoryVersionBody.parse(record.body);if(body.document!==document||body.space!==by.id)return fail('SOURCE_UNAVAILABLE');return {document,version,space:by.id,title:body.title,path:body.path,state:'superseded' as const,bytes:body.bytes,updated_at:body.at,updated_by:body.by,auto_load_allowed:false,current_version:null,markdown:await this.#text(body)};}
  if(!head||!await this.#mayRead(by,head.space,head.path))return fail('SOURCE_UNAVAILABLE');
  const current=await this.#version(head);if(head.space!==by.id&&!(head.space==='team'&&by.role==='admin')&&current.body.state!=='enabled')return fail('SOURCE_UNAVAILABLE');
  const own=head.space===by.id,adminTeam=head.space==='team'&&by.role==='admin';
  if(version&&version!==head.version&&!own&&!adminTeam)return fail('SOURCE_UNAVAILABLE');
  if(forSession&&(!(own||head.space==='team')||current.body.state!=='enabled'))return fail('SOURCE_UNAVAILABLE');
  if(forSession&&version!==head.version)return fail('MEMORY_CURSOR_STALE');
  if(forSession)this.#sessionLimits(heads);
  const selected=version??head.version,{body}=await this.#version(head,selected);
  const markdown=await this.#text(body);by=await this.#user(by);if(!await this.#mayRead(by,head.space,head.path))return fail('SOURCE_UNAVAILABLE');
  return {...this.#metadata(head,body,selected),current_version:head.version,markdown,auto_load_allowed:(own||head.space==='team')&&selected===head.version&&body.state==='enabled'};
 }
 async query(by:Principal,raw:unknown){
  by=await this.#user(by);const q=MemoryQuery.parse(raw),{cursor:ignored,...modeQuery}=q,mode=digest({by:by.id,q:modeQuery});
  if(q.document){const doc=await this.read(by,q.document,q.version,q.for_session),snapshot=digest({mode,version:doc.version,current:doc.current_version}),offset=cursor(q.cursor,snapshot,mode),bytes=Buffer.from(doc.markdown);if(offset>bytes.length)return fail('MEMORY_CURSOR_STALE');
   let end=Math.min(bytes.length,offset+16000);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
   return {memory_document:{...doc,markdown:bytes.subarray(offset,end).toString('utf8'),offset,next:end<bytes.length?nextCursor({snapshot,mode,offset:end}):null}};
  }
  const items=await this.items(by,q.scope,q.for_session),snapshot=digest({mode,items}),offset=cursor(q.cursor,snapshot,mode);if(offset>items.length)return fail('MEMORY_CURSOR_STALE');
  let conflicts:Array<{item_id:string;heads:string[]}>=[];const sync=this.#ctx.records.personalSync;if(sync&&(q.scope==='all'||q.scope==='personal')){const state=await sync.state(by);if(state.mode===SyncModeSchema.enum.hub&&state.snapshot)await sync.transact(by,state.epoch,async(scope,tx)=>{const list=await sync.note(by,state.epoch,'conflicts',state.snapshot!,tx) as Array<{item_id:string;heads:string[]}>|null;for(const conflict of list??[]){const object=await sync.object(by,state.epoch,conflict.heads[0],tx);if(object?.kind===SyncObjectKindSchema.enum.memory_revision||object?.kind===SyncObjectKindSchema.enum.deletion&&object.body.target_kind===SyncObjectKindSchema.enum.memory_revision)conflicts.push({item_id:conflict.item_id,heads:conflict.heads});}});}
  const page=(end:number)=>({scope:q.scope,snapshot,...(conflicts.length?{conflict_count:conflicts.length,conflicts:conflicts.slice(0,50)}:{}),items:items.slice(offset,end),next:end<items.length?nextCursor({snapshot,mode,offset:end}):null});
  let end=offset;
  while(end<items.length&&end-offset<50&&Buffer.byteLength(JSON.stringify(page(end+1)))<=16000)end++;
  if(end===offset&&end<items.length)return fail('MEMORY_DOCUMENT_LIMIT');
  return {memory_page:page(end)};
 }
 async history(by:Principal,document:string,rawCursor?:string){
  by=await this.#user(by);const current=await this.read(by,document);
  if(current.space!==by.id&&!(current.space==='team'&&by.role==='admin'))return fail('SOURCE_UNAVAILABLE');
  const rows=(await this.#all('memory_version','memory.version.document',document)).reverse();
  const snapshot=digest({by:by.id,document,version:current.current_version}),mode='memory.history',offset=cursor(rawCursor,snapshot,mode);
  if(offset>rows.length)return fail('MEMORY_CURSOR_STALE');
  const items=rows.slice(offset,offset+50).map(record=>{const body=MemoryVersionBody.parse(record.body);return {version:record.digest,title:body.title,path:body.path,state:record.digest===current.current_version?body.state:'superseded',bytes:body.bytes,at:body.at,by:body.by};});
  return {items,next:offset+50<rows.length?nextCursor({snapshot,mode,offset:offset+50}):null};
 }
 precheckGrant(by:Principal,path:string):Promise<SharingCheck[]>{return withReadScope(()=>this.#precheckGrant(by,path));}
 async #precheckGrant(by:Principal,path:string):Promise<SharingCheck[]>{
  by=await this.#user(by);path=pathCheck(path);
  const check:SharingCheck={check:ShareCheckSchema.enum.credentials,state:'pass',code:null,message:'',fix:''};
  try{
   const heads=(await this.#index().heads(by.id)).filter(head=>withinSpacePath(head.path,path));
   const rows=await Promise.allSettled(heads.map(async head=>{const {body}=await this.#version(head);return {body,text:await this.#text(body)};}));
   // Prefetch in batches, but preserve the scalar head order and the first scan/integrity failure.
   for(const row of rows){if(row.status==='rejected')throw row.reason;const {body,text}=row.value;this.#scan(body.title,body.path,text);}
  }
  catch(error){const code=error instanceof KnowledgeError&&error.code?error.code:'SOURCE_UNAVAILABLE';Object.assign(check,{state:code==='SPACE_CONTENT_UNINSPECTABLE'?'incomplete':'violation',code,message:error instanceof KnowledgeError?error.message:PROTOCOL_CODES[code].when,fix:PROTOCOL_CODES[code].fix});}
  return [check];
 }
 #scan(title:string,path:string,markdown:string){
  for(const [name,text] of [['title',title],['path',path],['markdown',markdown]]){
   const scan=scanForCredentials(Buffer.from(text));if(!scan.inspected||scan.truncated)return fail('SPACE_CONTENT_UNINSPECTABLE');
   const field=uiLabelOf('memory_field',name==='title'?MemoryFieldSchema.enum.document_title:name==='path'?MemoryFieldSchema.enum.directory_path:MemoryFieldSchema.enum.markdown_text);
   if(scan.findings.length)throw new KnowledgeError(PROTOCOL_CODES.MEMORY_CREDENTIALS_DETECTED.when+'；'+scan.findings.slice(0,5).map(f=>field+'第 '+f.line+' 行').join('、'),{code:'MEMORY_CREDENTIALS_DETECTED',detail:{positions:scan.findings.map(f=>({field:name,line:f.line,detector:f.detector}))}});
  }
 }
 async #audit(by:Principal,intent:string,payload:string,error:KnowledgeError){
  await this.#ctx.records.store.put({kind:'action',schema:'memory-refusal@1',provenance:'observed',unique_key:intent,body:{kind:ActionKindSchema.enum.validate,by:by.id,at:this.#now(),intent,payload,code:error.code,message:error.message,positions:error.code==='MEMORY_CREDENTIALS_DETECTED'?error.detail.positions??[]:[]},index:[{key:'memory.refusal.by',value:by.id}]});
 }
 #receipt(body:MemoryVersionBody,version:string,unchanged=false):MemoryWriteReceipt{return {document:body.document,version,previous_version:body.parent,space:body.space,state:body.state,bytes:body.bytes,updated_at:body.at,unchanged};}
 async #save(by:Principal,space:string,intent:string,payload:string,input:{title:string;path:string;markdown:string;state:MemoryVersionBody['state'];head?:MemoryHead;previous?:MemoryVersionBody},tx:Transaction){
  const sameText=input.previous&&input.markdown===await this.#text(input.previous,tx);
  if(input.head&&input.previous&&sameText&&input.title===input.previous.title&&input.path===input.previous.path&&input.state===input.previous.state){
   const receipt=this.#receipt(input.previous,input.head.version,true);
   await this.#ctx.records.store.put({kind:'action',schema:'memory-unchanged@1',provenance:'observed',unique_key:intent,body:{kind:ActionKindSchema.enum.validate,by:by.id,at:this.#now(),intent,payload,receipt}},tx);
   return receipt;
  }
  const epoch=space==='team'?undefined:await personalEpoch(this.#ctx,space,tx);
  const index=this.#index(),bytes=Buffer.byteLength(input.markdown),contextBytes=bytes+Buffer.byteLength(input.title+input.path),usage=await index.usage(space,tx);
  const active=usage.active-(input.head?.state==='enabled'?input.head.contextBytes:0)+(input.state==='enabled'?contextBytes:0),documents=usage.activeDocuments-Number(input.head?.state==='enabled')+Number(input.state==='enabled');
  if(bytes>index.limits.documentBytes&&!(input.state==='disabled'&&sameText))return fail('MEMORY_DOCUMENT_LIMIT');if(input.state==='enabled'&&(active>index.limits.spaceBytes||documents>index.limits.spaceDocuments))return fail('MEMORY_SPACE_LIMIT');
  if(input.state==='enabled'||!sameText||input.title!==input.previous?.title||input.path!==input.previous?.path)this.#scan(input.title,input.path,input.markdown);
  const capacity=await this.#spaces.capacityFacts(space,tx);
  let document=input.head?.document,docBytes=0;
  if(!document){const body=MemoryDocumentBody.parse({personal_epoch:epoch,space,by:by.id,at:this.#now(),intent});const doc=await this.#ctx.records.store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body,index:[{key:'memory.document.space',value:space}]},tx);document=doc.digest;docBytes=Buffer.byteLength(canonicalize(body));}
  const body=MemoryVersionBody.parse({personal_epoch:epoch,document,space,parent:input.head?.version??null,title:input.title,path:input.path,state:input.state,bytes,markdown:sameText?null:input.markdown,content_version:sameText?(input.previous!.content_version??input.head!.version):null,by:by.id,at:this.#now(),intent,payload});
  const history=docBytes+Buffer.byteLength(canonicalize(body));
  requireCapacity(capacity,history,space==='team'?{admin:by.role==='admin'}:undefined);
  const stored=await this.#ctx.records.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body,unique_key:intent,index:[{key:'memory.version.document',value:document},{key:'memory.version.space',value:space}]},tx);
  await index.apply({document,space,version:stored.digest,path:body.path,state:body.state,bytes,contextBytes},history,tx);if(epoch&&this.#ctx.records.personalSync)await this.#ctx.records.personalSync.assertCapacity(by,epoch,tx);return this.#receipt(body,stored.digest);
 }
 async write(by:Principal,raw:unknown):Promise<MemoryWriteReceipt>{
  by=await this.#user(by);const input=MemoryWriteInput.parse(raw),space=input.space==='team'?'team':by.id;if(space==='team'&&by.role!=='admin')return fail('SOURCE_UNAVAILABLE');
  const epoch=space===by.id?await personalEpoch(this.#ctx,by.id):undefined;
  const intent=digest([by.id,space,'memory.write',input.client_key,...(epoch&&epoch!==INITIAL_PERSONAL_EPOCH?[epoch]:[])]),payload=digest(input);
  try{return await this.#queue(space,()=>this.#ctx.records.store.withTransaction(async tx=>{
   await this.#ctx.records.store.lock('knowledge-space:'+space,tx);await guardPersonalEpoch(this.#ctx,by.id,epoch,tx);by=await lockActive(this.#ctx,by,tx);if(space==='team'&&by.role!=='admin')return fail('SOURCE_UNAVAILABLE');
   const cached=await this.#ctx.records.store.getByKey('memory_version',intent,tx);if(cached){const body=MemoryVersionBody.parse(cached.body);if(body.payload!==payload)return fail('IDEMPOTENCY_MISMATCH');return this.#receipt(body,cached.digest,true);}
   const action=await this.#ctx.records.store.getByKey<{payload:string;code?:ProtocolCode;message?:string;positions?:unknown[];receipt?:unknown}>('action',intent,tx);
   if(action){
    if(action.body.payload!==payload)return fail('IDEMPOTENCY_MISMATCH');
    if(action.schema==='memory-unchanged@1')return MemoryWriteReceipt.parse(action.body.receipt);
    const code=action.body.code;if(action.schema!=='memory-refusal@1'||!code||!Object.hasOwn(PROTOCOL_CODES,code))return fail('SOURCE_UNAVAILABLE');
    if(code!=='SPACE_CAPACITY_EXCEEDED')throw new KnowledgeError(action.body.message??PROTOCOL_CODES[code].when,{code,detail:{positions:action.body.positions??[]}});
   }
   const head=input.document?(await this.#index().heads(space,tx)).find(h=>h.document===input.document):undefined;if(input.document&&!head)return fail('SOURCE_UNAVAILABLE');if(head&&head.version!==input.expected_version)return fail('MEMORY_VERSION_CONFLICT');
   const previous=head?(await this.#version(head,head.version,tx)).body:undefined;
   return this.#save(by,space,intent,payload,{title:input.title??previous!.title,path:pathCheck(input.path??previous?.path??'/'),markdown:input.markdown??await this.#text(previous!,tx),state:input.enabled===undefined?previous?.state??'enabled':input.enabled?'enabled':'disabled',head,previous},tx);
  }));}catch(error){if(error instanceof KnowledgeError&&error.code&&error.code!=='SOURCE_UNAVAILABLE'&&error.code!=='IDEMPOTENCY_MISMATCH')await this.#audit(by,intent,payload,error);throw error;}
 }
 /** Internal aggregate replacement; no intermediate memory head becomes visible outside this transaction. */
 async syncProjection(by:Principal,epoch:string,rows:Array<{item_id:string;object:string;document?:string;version?:string;title:string;path:string;markdown:string;state:MemoryVersionBody['state']}>,reserved:{bytes:number;documents:number},tx:Transaction){
  await guardPersonalEpoch(this.#ctx,by.id,epoch,tx);by=await lockActive(this.#ctx,by,tx);const index=this.#index(),heads:MemoryHead[]=[],bindings:Array<{kind:import('../../contracts/generated/vocabulary.ts').SyncObjectKind;item_id:string;object_id:string;native:string;locator:string}>=[];
  let active=reserved.bytes,documents=reserved.documents;if(active>index.limits.spaceBytes||documents>index.limits.spaceDocuments)return fail('MEMORY_SPACE_LIMIT');
  const old=await index.heads(by.id,tx);
  for(const row of rows){
   MemoryWriteInput.parse({space:'personal',expected_version:null,title:row.title,path:row.path,markdown:row.markdown,client_key:row.object});this.#scan(row.title,row.path,row.markdown);const bytes=Buffer.byteLength(row.markdown),contextBytes=Buffer.byteLength(row.title+row.path+row.markdown);
   if(bytes>index.limits.documentBytes)return fail('MEMORY_DOCUMENT_LIMIT');if(row.state==='enabled'){active+=contextBytes;documents++;}
   if(active>index.limits.spaceBytes||documents>index.limits.spaceDocuments)return fail('MEMORY_SPACE_LIMIT');
   let document=row.document;
   if(!document){const body=MemoryDocumentBody.parse({personal_epoch:epoch,space:by.id,by:by.id,at:this.#now(),intent:digest([epoch,row.item_id,'sync-document'])});document=(await this.#ctx.records.store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body,index:[{key:'memory.document.space',value:by.id}]},tx)).digest;}
   const identity=await this.#ctx.records.store.get(document,tx);if(identity?.kind!=='memory_document'||MemoryDocumentBody.parse(identity.body).space!==by.id)return fail('SOURCE_UNAVAILABLE');
   const existing=row.version?await this.#ctx.records.store.get(row.version,tx):null;let version=row.version;
   if(!existing||existing.kind!=='memory_version'){
    const body=MemoryVersionBody.parse({personal_epoch:epoch,document,space:by.id,parent:old.find(h=>h.document===document)?.version??null,title:row.title,path:row.path,state:row.state,bytes,markdown:row.markdown,content_version:null,by:by.id,at:this.#now(),intent:digest([epoch,row.object,'sync-version']),payload:digest(row.object)});
    version=(await this.#ctx.records.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body,index:[{key:'memory.version.document',value:document},{key:'memory.version.space',value:by.id}]},tx)).digest;
   }else{const body=MemoryVersionBody.parse(existing.body);if(body.document!==document||body.space!==by.id||body.title!==row.title||body.path!==row.path||body.state!==row.state||await this.#text(body,tx)!==row.markdown)return fail('SYNC_OBJECT_INVALID');}
   heads.push({document,space:by.id,version:version!,path:row.path,state:row.state,bytes,contextBytes});bindings.push({kind:'memory_revision',item_id:row.item_id,object_id:row.object,native:version!,locator:document});
  }
  if(!index.replacePersonal)return fail('SOURCE_UNAVAILABLE');await index.replacePersonal(by.id,epoch,heads,tx);return bindings;
 }

 async grant(by:Principal,input:{path:string;audience:KnowledgeGrantee;member?:string|null;revoke?:boolean}){
  by=await this.#user(by);const epoch=await personalEpoch(this.#ctx,by.id);const body=MemoryGrantBody.parse({personal_epoch:epoch,space:by.id,path:pathCheck(input.path),audience:input.audience,member:input.member??null,action:input.revoke?'revoke':'grant',by:by.id,at:this.#now(),intent:digest(newId('evt'))});
  return this.#queue(by.id,()=>this.#ctx.records.store.withTransaction(async tx=>{await this.#ctx.records.store.lock('knowledge-space:'+by.id,tx);await guardPersonalEpoch(this.#ctx,by.id,epoch,tx);by=await lockActive(this.#ctx,by,tx);if(body.member){const user=await this.#ctx.records.principals.get(body.member);if(!user||!input.revoke&&user.disabled)return fail('SOURCE_UNAVAILABLE');}
   if(!input.revoke)for(const head of await this.#index().heads(by.id,tx))if(withinSpacePath(head.path,body.path)){const {body:version}=await this.#version(head,head.version,tx);this.#scan(version.title,version.path,await this.#text(version,tx));}
   return this.#ctx.records.store.put({kind:'memory_grant',schema:'memory-grant@1',provenance:'declared',body,index:[{key:'memory.grant.owner',value:by.id},{key:'memory.grant.grantee',value:body.member??'administrators'}]},tx);
  }));
 }
 async usage(by:Principal,space=by.id){by=await this.#user(by);if(space!==by.id&&by.role!=='admin')return fail('SOURCE_UNAVAILABLE');const facts=space==='team'?await historyUsage(this.#ctx.records.store,space):await this.#spaces.usage(by,space);return {...await this.#index().usage(space),history:facts.memory,limits:this.#index().limits};}
 async rebuild(by:Principal,space=by.id){
  by=await this.#user(by);if(space!==by.id&&(space!=='team'||by.role!=='admin'))return fail('SOURCE_UNAVAILABLE');
  return this.#queue(space,()=>this.#ctx.records.store.withTransaction(async tx=>{
   await this.#ctx.records.store.lock('knowledge-space:'+space,tx);by=await lockActive(this.#ctx,by,tx);if(space==='team'&&by.role!=='admin')fail('SOURCE_UNAVAILABLE');
   if(space===by.id&&this.#ctx.records.personalSync){const epoch=await personalEpoch(this.#ctx,by.id,tx);if(epoch){const projection=await this.#ctx.records.personalSync.memoryProjection(by,epoch,tx);if(projection){const selected=new Map(projection.heads.map(h=>[h.document,h]));for(const row of projection.versions){const body=MemoryVersionBody.parse(row.body);selected.set(body.document,{document:body.document,space,version:row.digest,path:body.path,state:body.state,bytes:body.bytes,contextBytes:Buffer.byteLength(body.title+body.path)+body.bytes});}if(!this.#index().replacePersonal)return fail('SOURCE_UNAVAILABLE');await this.#index().replacePersonal!(space,epoch,[...selected.values()],tx);await this.#ctx.records.personalSync.reserve(by,epoch,projection.reserved.bytes,projection.reserved.documents,tx);return;}}}
   const heads:MemoryHead[]=[];let history=0;
   for(const doc of await this.#all('memory_document','memory.document.space',space,tx)){
    const identity=MemoryDocumentBody.parse(doc.body);if(identity.space!==space)continue;history+=Buffer.byteLength(canonicalize(identity));
    const versions=await this.#all('memory_version','memory.version.document',doc.digest,tx);let latest:MemoryHead|undefined;
    for(const row of versions){const body=MemoryVersionBody.parse(row.body);if(body.space!==space||body.document!==doc.digest)fail('SOURCE_UNAVAILABLE');history+=Buffer.byteLength(canonicalize(body));latest={document:doc.digest,space,version:row.digest,path:body.path,state:body.state,bytes:body.bytes,contextBytes:body.bytes+Buffer.byteLength(body.title+body.path)};}
    if(latest)heads.push(latest);
   }
   await this.#index().rebuild(space,heads,history,tx);return {documents:heads.length};
  }));
 }
 async #sharePlan(by:Principal,input:ReturnType<typeof MemoryShareInput.parse>,tx?:Transaction){
  const source=await this.read(by,input.document,input.version);if(source.space!==by.id)return fail('SOURCE_UNAVAILABLE');if(source.version!==source.current_version)return fail('MEMORY_VERSION_CONFLICT');
  const checks:SharingCheck[]=ShareCheckSchema.extract(['team_memory_status','size','credentials']).options.map(check=>({check,state:'unchecked',code:null,message:'',fix:''}));let phase=0;
  const history=await this.#all('memory_share','memory.share.source',by.id+':'+input.document,tx);
  const merged=history.map(row=>MemoryShareBody.parse(row.body)).filter(r=>r.status==='merged'&&r.by===by.id&&r.document===input.document),previous=merged.at(-1);
  const heads=new Map((await this.#index().heads('team',tx)).map(head=>[head.document,head])),old=previous?.team_document?heads.get(previous.team_document):undefined;
  const disabled=merged.some(share=>share.team_document&&heads.get(share.team_document)?.state==='disabled');
  const replacement=old&&old.version===previous?.team_version?old:undefined;
  const target=pathCheck(input.team_path??source.path),effect=replacement?'replace':'create';
  const scan=scanForCredentials(Buffer.from(target)),safeTarget=scan.inspected&&!scan.truncated&&!scan.findings.length;
  try{
   if(disabled)fail('MEMORY_TEAM_DISABLED');checks[phase++].state='pass';
   const index=this.#index(),usage=await index.usage('team',tx),contextBytes=Buffer.byteLength(source.title+target+source.markdown),documents=usage.activeDocuments-Number(replacement?.state==='enabled')+1;
   if(source.bytes>index.limits.documentBytes)fail('MEMORY_DOCUMENT_LIMIT');if(usage.active-(replacement?.state==='enabled'?replacement.contextBytes:0)+contextBytes>index.limits.spaceBytes||documents>index.limits.spaceDocuments)fail('MEMORY_SPACE_LIMIT');
   checks[phase++].state='pass';this.#scan(source.title,target,source.markdown);checks[phase].state='pass';
  }catch(error){const code=error instanceof KnowledgeError&&error.code?error.code:'SOURCE_UNAVAILABLE';checks[phase]={...checks[phase],state:code==='SPACE_CONTENT_UNINSPECTABLE'?'incomplete':'violation',code,message:error instanceof KnowledgeError?error.message:PROTOCOL_CODES[code].when,fix:PROTOCOL_CODES[code].fix};}
  return {source,checks,replacement,target,safeTarget,effect:disabled?null:effect as MemoryShareBody['effect'],ok:checks.every(c=>c.state==='pass')};
 }
 async share(by:Principal,raw:unknown):Promise<MemorySharingResult>{
  by=await this.#user(by);const input=MemoryShareInput.parse(raw),intent=digest([by.id,'memory.share',input.client_key]),payload=digest({...input,check_only:false});
  if(input.check_only){const plan=await this.#sharePlan(by,input);return {ok:plan.ok,checks:plan.checks,effect:plan.effect,replaces:plan.replacement?.document??null,title:plan.source.title,...(plan.safeTarget?{target_path:plan.target}:{})};}
  return this.#queue('team',()=>this.#ctx.records.store.withTransaction(async tx=>{
   await this.#ctx.records.store.lock('knowledge-space:'+by.id,tx);await this.#ctx.records.store.lock('knowledge-space:team',tx);by=await lockActive(this.#ctx,by,tx);
   const cached=await this.#ctx.records.store.getByKey('memory_share',intent,tx);if(cached){const body=MemoryShareBody.parse(cached.body);if(body.payload!==payload)fail('IDEMPOTENCY_MISMATCH');return {ok:body.status==='merged',checks:[],effect:body.effect,replaces:body.effect==='replace'?body.team_document:null,title:'',target_path:body.target_path,share:body,record:cached.digest};}
   const plan=await this.#sharePlan(by,input,tx);let saved:MemoryWriteReceipt|null=null;
   if(plan.ok){const previous=plan.replacement?(await this.#version(plan.replacement,plan.replacement.version,tx)).body:undefined;saved=await this.#save(by,'team',intent,payload,{title:plan.source.title,path:plan.target,markdown:plan.source.markdown,state:'enabled',head:plan.replacement,previous},tx);}
   const failed=plan.checks.find(c=>c.state!=='pass'),body=MemoryShareBody.parse({document:input.document,version:input.version,by:by.id,at:this.#now(),intent,payload,status:plan.ok?'merged':'rejected',code:failed?.code??null,message:failed?.message??'',...(plan.safeTarget?{target_path:plan.target}:{}),team_document:saved?.document??null,team_version:saved?.version??null,effect:plan.effect,replaces:plan.replacement?.version??null});
   const record=await this.#ctx.records.store.put({kind:'memory_share',schema:'memory-share@1',provenance:'declared',unique_key:intent,body,index:[{key:'memory.share.by',value:by.id},{key:'memory.share.source',value:by.id+':'+input.document}]},tx);return {ok:plan.ok,checks:plan.checks,effect:plan.effect,replaces:plan.replacement?.document??null,title:plan.source.title,...(plan.safeTarget?{target_path:plan.target}:{}),share:body,record:record.digest};
  }));
 }
}
