import {ApiError,Base64Content,MAX_SOURCE_BYTES,canonicalHash,canonicalJson,newId,requireCondition,sha256,type AuthContext,
  KnowledgeSourceInput,KnowledgeEvidenceInput,KnowledgeEntityInput,KnowledgeClaimInput,KnowledgeReviewInput,KnowledgeSnapshotInput} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Knowledge,SourceAccessPin} from './index.ts';
import {z} from 'zod';

type Row=Record<string,any>;
const permit=(readers:string[],id:string)=>readers.includes(id)||readers.includes('*');

export class KnowledgeGraph {
  store:Store;auth:Auth;objects:Knowledge;
  constructor(store:Store,auth:Auth,objects:Knowledge){this.store=store;this.auth=auth;this.objects=objects;}
  denied():never{throw new ApiError('SOURCE_FORBIDDEN','Knowledge record is not available to this identity');}
  async ownerReadable(ctx:AuthContext,row:Row|undefined,tx?:Transaction):Promise<boolean>{
    if(!row)return false;const policy=await this.auth.policy(ctx,tx);
    return policy.tenantId===row.tenant_id&&policy.principalId===row.owner_id&&policy.scopes.includes(row.scope_id)&&(policy.scopeGrants?.[row.scope_id]??[]).includes('knowledge.read');
  }
  async noteDenied(ctx:AuthContext,row:Row|undefined):Promise<void>{
    if(!row||row.tenant_id!==ctx.tenantId)return;
    await this.auth.audit(ctx,'knowledge.access-denied',{code:'SOURCE_FORBIDDEN',recordId:row.record_id},row.scope_id);
  }
  contentDescriptor(row:Row):{mediaType:string;fileName:string}{
    if(row.kind==='KnowledgeSnapshot')return {mediaType:'application/json',fileName:`${row.record_id}.json`};
    const payload=row.payload??{},fromPath=typeof payload.path==='string'?payload.path.split('/').filter(Boolean).at(-1):undefined;
    const stored=typeof payload.raw?.fileName==='string'&&!/\.bin$/i.test(payload.raw.fileName)?payload.raw.fileName:undefined;
    const fileName=typeof payload.fileName==='string'&&payload.fileName?payload.fileName:fromPath||stored||`${row.record_id}.bin`;
    const extension=fileName.toLowerCase().split('.').pop();
    const mediaType=typeof payload.mediaType==='string'&&payload.mediaType?payload.mediaType:extension==='json'?'application/json':extension==='md'?'text/markdown':extension==='csv'?'text/csv':extension==='txt'||extension==='text'?'text/plain':'application/octet-stream';
    return {mediaType,fileName};
  }
  view(row:Row):any{return {recordId:row.record_id,kind:row.kind,scopeId:row.scope_id,ownerPrincipalId:row.owner_id,knowledgeCategory:row.knowledge_category,
    sourceType:row.source_type,visibility:row.visibility,state:row.state,sha256:row.sha256,payload:row.payload};}
  async row(id:string,tx?:Transaction):Promise<Row|undefined>{return (await (tx??this.store.pool).query('SELECT * FROM knowledge_records WHERE record_id=$1',[id])).rows[0];}
  async closure(row:Row,tx?:Transaction):Promise<Row[]>{
    const seen=new Map([[row.record_id,row]]),queue=[row];
    while(queue.length){const current=queue.shift()!;for(const id of current.reference_ids){if(seen.has(id))continue;const next=await this.row(id,tx);requireCondition(next,'SOURCE_HASH_MISMATCH','Knowledge reference is missing');seen.set(id,next);queue.push(next);}}
    return [...seen.values()];
  }
  async pinnedSource(ctx:AuthContext,source:Row,pin:SourceAccessPin|undefined,tx?:Transaction):Promise<Row|undefined>{
    if(!pin||source.payload.asset?.assetId!==pin.assetId)return;
    const row=(await(tx??this.store.pool).query(`SELECT a.*,v.*,live.readers AS live_readers FROM assets a JOIN asset_versions v USING(asset_id)
      LEFT JOIN LATERAL(SELECT readers FROM asset_versions WHERE asset_id=a.asset_id AND lifecycle IN ('approved','running') AND approved_digest=sha256 ORDER BY created_at DESC,version DESC LIMIT 1) live ON true
      WHERE a.asset_id=$1 AND v.version=$2`,[pin.assetId,pin.version])).rows[0];
    const file=row?.configuration?.files?.find((entry:any)=>entry.sourceRecordId===source.record_id);
    // Only an original explicitly listed by this frozen artifact uses its pin.
    // Independent bases and other records keep their ordinary live authority.
    if(!file)return;
    if(row.tenant_id!==ctx.tenantId||row.scope_id!==source.scope_id||row.kind!=='knowledge-source'||row.configuration.schema!=='external-source-artifact/1'||row.sha256!==pin.sha256||row.approved_digest!==row.sha256||!['approved','running'].includes(row.lifecycle)||!row.live_readers)this.denied();
    if(source.kind!=='SourceRevision'||source.knowledge_category!=='product'||source.sha256!==file.sha256||source.payload.raw?.sourceRevisionId!==file.sourceRevisionId||source.payload.raw?.sha256!==file.sha256||source.payload.raw?.size!==file.size||source.payload.path!==`/${file.path}`)throw new ApiError('SOURCE_HASH_MISMATCH','Frozen original record differs from the approved artifact');
    if(row.owner_principal_id!==ctx.principalId&&(!permit(row.readers,ctx.principalId)||!permit(row.live_readers,ctx.principalId)))this.denied();return row;
  }
  async visible(ctx:AuthContext,row:Row|undefined,tx?:Transaction,pin?:SourceAccessPin):Promise<boolean>{
    if(!row)return false;const p=await this.auth.check(ctx,'knowledge.read',undefined,tx);
    if(row.tenant_id!==p.tenantId||!p.scopes.includes(row.scope_id)||row.visibility==='personal'&&row.owner_id!==p.principalId)return false;
    for(const source of (await this.closure(row,tx)).filter(x=>x.kind==='SourceRevision')){
      if(source.tenant_id!==p.tenantId||!p.scopes.includes(source.scope_id)||source.visibility==='personal'&&source.owner_id!==p.principalId)return false;
      const frozen=await this.pinnedSource(ctx,source,pin,tx);
      const current=frozen?source:(await (tx??this.store.pool).query(`SELECT r.* FROM knowledge_source_heads h JOIN knowledge_records r USING(record_id)
        WHERE h.tenant_id=$1 AND h.scope_id=$2 AND h.identity_key=$3`,[source.tenant_id,source.scope_id,source.payload.sourceIdentity])).rows[0];
      if(!current)return false;
      for(const revision of [source,current])if(!permit(revision.payload.acl.sourceReaders,p.principalId)||!permit(revision.payload.acl.platformReaders,p.principalId))return false;
      let asset=source.payload.asset;
      // Older retained tool sources also obey the current asset's reader policy.
      if(!asset&&source.payload.parserVersion==='tool-return/1')try{const key=JSON.parse(source.payload.sourceId);if(Array.isArray(key)&&typeof key[0]==='string'&&key[0].startsWith('ast_'))asset={assetId:key[0]};}catch{/* A manually ingested source has no implicit asset binding. */}
      if(asset){const authority=frozen??(await (tx??this.store.pool).query(`SELECT a.tenant_id,a.scope_id,a.owner_principal_id,v.readers,v.declaration FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.asset_id=$1`,[asset.assetId])).rows[0];
        if(!authority||authority.tenant_id!==p.tenantId||!p.scopes.includes(authority.scope_id)||authority.owner_principal_id!==p.principalId&&!permit(authority.readers,p.principalId)||asset.permission&&!p.grants.includes(asset.permission))return false;
        for(const reference of authority.declaration.credentials){
          const credential=(await (tx??this.store.pool).query(`SELECT a.tenant_id,a.scope_id,a.owner_principal_id,v.lifecycle,v.configuration FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.asset_id=$1 AND a.kind='credential-reference'`,[reference])).rows[0];
          if(!credential||credential.tenant_id!==p.tenantId||!p.scopes.includes(credential.scope_id)||credential.configuration.credentialMode!=='static-secret'&&credential.owner_principal_id!==p.principalId||credential.lifecycle==='disabled'||credential.configuration.connectorAssetId!==asset.assetId)return false;
        }
      }
    }return true;
  }
  async get(ctx:AuthContext,id:string,tx?:Transaction,pin?:SourceAccessPin):Promise<any>{const row=await this.row(id,tx);if(!await this.visible(ctx,row,tx,pin))this.denied();return this.view(row!);}
  async content(ctx:AuthContext,id:string):Promise<any>{
    const row=await this.row(id);if(!await this.visible(ctx,row)&&!await this.ownerReadable(ctx,row)){await this.noteDenied(ctx,row);this.denied();}
    requireCondition(['SourceRevision','Evidence','KnowledgeSnapshot'].includes(row!.kind),'INVALID_PAYLOAD','This record has no original byte content');
    const bytes=row!.kind==='KnowledgeSnapshot'?Buffer.from(row!.payload.canonicalManifest):await this.objects.objects.getObject({Bucket:'evidence',Key:row!.sha256});
    requireCondition(sha256(bytes)===row!.sha256,'SOURCE_HASH_MISMATCH','Knowledge content SHA differs');
    const descriptor=this.contentDescriptor(row!);
    return {reference:{sha256:row!.sha256,size:bytes.length,mediaType:descriptor.mediaType,fileName:descriptor.fileName},bytes};
  }
  async need(ctx:AuthContext,id:string,kind:string,tx:Transaction):Promise<Row>{const row=await this.row(id,tx);if(!await this.visible(ctx,row,tx))this.denied();requireCondition(row!.kind===kind,'INVALID_PAYLOAD','Knowledge reference kind differs');return row!;}
  async save(tx:Transaction,ctx:AuthContext,kind:string,scope:string,key:string,payload:any,references:string[],settings:{category:string;sourceType:string;visibility:string;state:string;digest?:string;searchText?:string}):Promise<any>{
    const hash=canonicalHash({kind,payload,references,category:settings.category,sourceType:settings.sourceType});
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson([ctx.tenantId,scope,kind,key])]);
    const old=(await tx.query('SELECT * FROM knowledge_records WHERE tenant_id=$1 AND scope_id=$2 AND kind=$3 AND identity_key=$4',[ctx.tenantId,scope,kind,key])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_MISMATCH','Knowledge revision identity is immutable');return {...this.view(old),deduplicated:true};}
    const id=newId('knr');const row=(await tx.query(`INSERT INTO knowledge_records(record_id,kind,tenant_id,scope_id,owner_id,knowledge_category,source_type,visibility,state,identity_key,request_hash,sha256,payload,reference_ids,search_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[id,kind,ctx.tenantId,scope,ctx.principalId,settings.category,settings.sourceType,settings.visibility,settings.state,key,hash,settings.digest??canonicalHash(payload),JSON.stringify(payload),references,settings.searchText??''])).rows[0];
    if(references.length)await tx.query('INSERT INTO knowledge_references(record_id,reference_id) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',[id,[...new Set(references)]]);
    await this.auth.audit(ctx,'knowledge.record',{recordId:id,kind,sha256:row.sha256,knowledgeCategory:settings.category},scope,tx);return {...this.view(row),deduplicated:false};
  }
  async source(ctx:AuthContext,value:unknown):Promise<any>{
    const input=KnowledgeSourceInput.parse(value),bytes=Buffer.from(input.contentBase64,'base64');
    requireCondition(!input.sha256||input.sha256===sha256(bytes),'SOURCE_HASH_MISMATCH','Original bytes differ from the declared SHA');
    if(['shared-session','skill-run','bot-run','review-correction','footprint'].includes(input.sourceType))requireCondition(input.knowledgeCategory==='consolidated','INVALID_PAYLOAD','Shared or model sources must be consolidated knowledge');
    if(input.knowledgeCategory==='consolidated')requireCondition(input.sharing?.allowed===true,'SHARING_REQUIRED','Consolidation requires explicit sharing consent');
    return this.store.transaction(async tx=>{
      const p=await this.auth.check(ctx,'knowledge.ingest',input.scopeId,tx);
      if(input.knowledgeCategory==='product'&&[...input.acl.sourceReaders,...input.acl.platformReaders].some(id=>id!==ctx.principalId))await this.auth.check(ctx,'admin.manage',input.scopeId,tx);
      const sourceIdentity=canonicalHash([input.sourceId,input.knowledgeCategory,input.knowledgeCategory==='consolidated'?p.principalId:null]);
      const key=canonicalHash([sourceIdentity,input.revision]);
      // Lock the source head as well as its revision to serialize concurrent updates.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson([p.tenantId,input.scopeId,sourceIdentity])]);
      const raw=await this.objects.upload(ctx,input.scopeId,`knowledge-${sha256(bytes).slice(0,16)}.bin`,bytes,tx);
      const payload={sourceId:input.sourceId,sourceIdentity,revision:input.revision,path:input.path,parserVersion:input.parserVersion,acl:input.acl,sharing:input.sharing??null,raw};
      const record=await this.save(tx,ctx,'SourceRevision',input.scopeId,key,payload,[],{category:input.knowledgeCategory,sourceType:input.sourceType,visibility:input.knowledgeCategory==='product'?'team':'personal',state:'observed',digest:raw.sha256});
      if(!record.deduplicated)await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,scope_id,identity_key) DO UPDATE SET record_id=EXCLUDED.record_id`,[p.tenantId,input.scopeId,sourceIdentity,record.recordId]);return record;
    });
  }
  async evidence(ctx:AuthContext,value:unknown):Promise<any>{const input=KnowledgeEvidenceInput.parse(value);return this.store.transaction(async tx=>{
    const source=await this.need(ctx,input.sourceRecordId,'SourceRevision',tx);await this.auth.check(ctx,'knowledge.submit',source.scope_id,tx);
    const raw=await this.objects.objects.getObject({Bucket:'evidence',Key:source.payload.raw.sha256});requireCondition(sha256(raw)===source.payload.raw.sha256,'SOURCE_HASH_MISMATCH','Stored original SHA differs');
    requireCondition(input.start<input.end&&input.end<=raw.length,'INVALID_PAYLOAD','Evidence byte range is outside the fixed original');
    const quote=raw.subarray(input.start,input.end);requireCondition(input.quoteBase64===undefined||Buffer.from(input.quoteBase64,'base64').equals(quote),'SOURCE_HASH_MISMATCH','Evidence quote differs from its byte range');
    const digest=sha256(quote);await this.objects.objects.putObject({Bucket:'evidence',Key:digest,Body:quote});
    const payload={sourceRecordId:source.record_id,start:input.start,end:input.end,sha256:digest,text:quote.toString('utf8'),path:source.payload.path};
    return this.save(tx,ctx,'Evidence',source.scope_id,canonicalHash([source.record_id,input.start,input.end]),payload,[source.record_id],{category:source.knowledge_category,sourceType:source.source_type,visibility:source.visibility,state:'observed',digest});
  });}
  async entity(ctx:AuthContext,value:unknown):Promise<any>{const input=KnowledgeEntityInput.parse(value);return this.store.transaction(async tx=>{
    const source=await this.need(ctx,input.sourceRecordId,'SourceRevision',tx);await this.auth.check(ctx,'knowledge.submit',source.scope_id,tx);
    if(input.entityRevisionId){const observation=(await tx.query('SELECT e.tenant_id,e.scope_id FROM entity_observations o JOIN entities e USING(entity_id) WHERE entity_revision_id=$1',[input.entityRevisionId])).rows[0];requireCondition(observation?.tenant_id===ctx.tenantId&&observation.scope_id===source.scope_id,'SOURCE_FORBIDDEN','Entity revision is outside this source partition');}
    return this.save(tx,ctx,'Entity',source.scope_id,canonicalHash(input),input,[source.record_id],{category:source.knowledge_category,sourceType:source.source_type,visibility:source.visibility,state:'candidate'});
  });}
  async claim(ctx:AuthContext,value:unknown,transaction?:Transaction):Promise<any>{const input=KnowledgeClaimInput.parse(value);const run=async(tx:Transaction)=>{
    await this.auth.check(ctx,'knowledge.submit',input.scopeId,tx);const evidence:Row[]=[];
    for(const id of input.evidenceIds)evidence.push(await this.need(ctx,id,'Evidence',tx));
    const first=evidence[0];requireCondition(evidence.every(e=>e.scope_id===input.scopeId&&e.knowledge_category===first.knowledge_category),'INVALID_PAYLOAD','Claim evidence must share its scope and category');
    for(const id of input.entityIds){const entity=await this.need(ctx,id,'Entity',tx);requireCondition(entity.scope_id===input.scopeId&&entity.knowledge_category===first.knowledge_category,'INVALID_PAYLOAD','Entity belongs to another knowledge partition');}
    const sourcePaths=[...new Set(evidence.map(e=>e.payload.path))],payload={...input,sourcePaths};
    const result=await this.save(tx,ctx,'Claim',input.scopeId,canonicalHash([ctx.principalId,input]),payload,[...input.evidenceIds,...input.entityIds],{
      category:first.knowledge_category,sourceType:first.source_type,visibility:first.knowledge_category==='consolidated'?'personal':'team',state:'candidate',searchText:[input.subject,input.predicate,canonicalJson(input.value),...evidence.map(e=>e.payload.text)].join(' ')});
    return {...result,conflicts:await this.conflicts(ctx,(await this.row(result.recordId,tx))!,tx)};
  };return transaction?run(transaction):this.store.transaction(run);}
  // Internal B capture, called only after D has verified the live operation/fence.
  // A read tool can retain its own observations without granting a public ingestion API.
  async capture(tx:Transaction,ctx:AuthContext,scopeId:string,assetId:string,raw:{path:string;sha256:string;contentBase64:string;sourceType:string;requestKey?:string;plaintextAuthentication?:boolean},permission?:string):Promise<any>{
    const p=await this.auth.policy(ctx,tx);requireCondition(p.tenantId===ctx.tenantId&&p.scopes.includes(scopeId),'FORBIDDEN_SCOPE','Observation exceeds the execution partition');
    Base64Content.parse(raw.contentBase64);const bytes=Buffer.from(raw.contentBase64,'base64');requireCondition(bytes.length>0&&bytes.length<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Observation exceeds the byte limit');requireCondition(sha256(bytes)===raw.sha256,'SOURCE_HASH_MISMATCH','Worker original SHA differs');
    await this.objects.objects.putObject({Bucket:'evidence',Key:raw.sha256,Body:bytes});
    const stored=(await tx.query(`INSERT INTO sources(source_revision_id,tenant_id,scope_id,principal_id,sha256,size,object_key,file_name) VALUES($1,$2,$3,$4,$5,$6,$5,$7)
      ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,[newId('src'),ctx.tenantId,scopeId,ctx.principalId,raw.sha256,bytes.length,`tool-${raw.sha256.slice(0,16)}.bin`])).rows[0];
    const sourceId=canonicalJson([assetId,ctx.principalId,raw.path,raw.requestKey??null,'source-authority/1']),sourceIdentity=canonicalHash([sourceId,'product']),payload={sourceId,sourceIdentity,revision:raw.sha256,path:raw.path,parserVersion:'tool-return/1',acl:{sourceReaders:[ctx.principalId],platformReaders:[ctx.principalId]},asset:{assetId,...(permission?{permission}:{})},sharing:null,raw:{...this.objects.sourceReference(stored),...(raw.plaintextAuthentication?{plaintextAuthentication:true}:{})},...(raw.plaintextAuthentication?{plaintextAuthentication:true}:{})};
    const source=await this.save(tx,ctx,'SourceRevision',scopeId,canonicalHash([sourceIdentity,raw.sha256,...(raw.plaintextAuthentication?['plaintext-authentication']:[])]),payload,[],{category:'product',sourceType:raw.sourceType,visibility:'team',state:'observed',digest:raw.sha256});
    const previous=(await tx.query('SELECT record_id FROM knowledge_source_heads WHERE tenant_id=$1 AND scope_id=$2 AND identity_key=$3',[ctx.tenantId,scopeId,sourceIdentity])).rows[0]?.record_id;
    const head=(await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,scope_id,identity_key) DO UPDATE SET record_id=EXCLUDED.record_id,generation=knowledge_source_heads.generation+CASE WHEN knowledge_source_heads.record_id=EXCLUDED.record_id THEN 0 ELSE 1 END RETURNING generation`,[ctx.tenantId,scopeId,sourceIdentity,source.recordId])).rows[0];
    const text=bytes.toString('utf8'),inline=bytes.length<=65536&&!text.includes('\u0000')&&Buffer.from(text).equals(bytes);
    const evidence=await this.save(tx,ctx,'Evidence',scopeId,canonicalHash([source.recordId,0,bytes.length,'original-pointer/1']),{sourceRecordId:source.recordId,start:0,end:bytes.length,sha256:raw.sha256,content:{objectKey:raw.sha256,size:bytes.length,encoding:inline?'utf8':'opaque'},...(raw.plaintextAuthentication?{plaintextAuthentication:true}:{}),...(inline?{text}:{textExcerpt:text.slice(0,2000).replaceAll('\u0000',''),textInline:false,sanitized:text.includes('\u0000')||!Buffer.from(text).equals(bytes),encodingValid:Buffer.from(text).equals(bytes),nulBytes:bytes.reduce((total,byte)=>total+(byte===0?1:0),0)}),path:raw.path},[source.recordId],{category:'product',sourceType:raw.sourceType,visibility:'team',state:'observed',digest:raw.sha256});
    return {evidenceId:evidence.recordId,sha256:evidence.sha256,sourceRecordId:source.recordId,generation:Number(head.generation),requestKey:raw.requestKey,supersededSourceId:previous&&previous!==source.recordId?previous:null};
  }
  async candidateFromReturns(tx:Transaction,ctx:AuthContext,scopeId:string,taskId:string,input:any):Promise<any>{
    await this.auth.check(ctx,'knowledge.submit',scopeId,tx);const evidence:Row[]=[];
    for(const [index,ref] of input.evidence.entries()){
      let row:Row;try{row=await this.need(ctx,ref.evidenceId,'Evidence',tx);}catch(error){
        // Echo only the submitted reference; absent and hidden records keep the
        // same classification and never reveal the referenced object's fields.
        if(error instanceof ApiError&&error.code==='SOURCE_FORBIDDEN')throw new ApiError(error.code,error.message,{field:'evidence',index,evidenceId:ref.evidenceId});throw error;
      }
      requireCondition(row.scope_id===scopeId&&row.sha256===ref.sha256,'SOURCE_HASH_MISMATCH','Submitted evidence differs from the authorized return');evidence.push(row);
    }
    const bytes=Buffer.from(canonicalJson({claim:input.claim,toolReturns:input.evidence})),digest=sha256(bytes);await this.objects.objects.putObject({Bucket:'evidence',Key:digest,Body:bytes});
    const stored=(await tx.query(`INSERT INTO sources(source_revision_id,tenant_id,scope_id,principal_id,sha256,size,object_key,file_name) VALUES($1,$2,$3,$4,$5,$6,$5,$7)
      ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,[newId('src'),ctx.tenantId,scopeId,ctx.principalId,digest,bytes.length,`candidate-${digest.slice(0,16)}.json`])).rows[0];
    const sourceIdentity=canonicalHash(['candidate-submit',ctx.principalId,canonicalHash(input)]),payload={sourceId:`candidate:${sourceIdentity}`,sourceIdentity,revision:digest,path:`candidate:${sourceIdentity}`,parserVersion:'candidate-submit/1',acl:{sourceReaders:[ctx.principalId],platformReaders:[ctx.principalId]},sharing:{allowed:true,teamPromotion:false},raw:this.objects.sourceReference(stored)};
    const source=await this.save(tx,ctx,'SourceRevision',scopeId,sourceIdentity,payload,evidence.map(e=>e.record_id),{category:'consolidated',sourceType:'skill-run',visibility:'personal',state:'observed',digest});
    await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[ctx.tenantId,scopeId,sourceIdentity,source.recordId]);
    const quote=await this.save(tx,ctx,'Evidence',scopeId,canonicalHash([source.recordId,digest]),{sourceRecordId:source.recordId,start:0,end:bytes.length,sha256:digest,text:bytes.toString(),path:payload.path},[source.recordId,...evidence.map(e=>e.record_id)],{category:'consolidated',sourceType:'skill-run',visibility:'personal',state:'observed',digest});
    return this.claim(ctx,{scopeId,subject:input.claim.subject,predicate:input.claim.predicate,value:input.claim.value,conditions:input.claim.conditions??{},evidenceIds:[quote.recordId],origin:'model'},tx);
  }
  async sharedFragments(tx:Transaction,ctx:AuthContext,scopeId:string,limit:number,after?:string):Promise<any>{
    await this.auth.check(ctx,'knowledge.read',scopeId,tx);
    requireCondition(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_PAYLOAD','Fragment page limit must be between 1 and 100');
    const binding=canonicalHash([ctx.tenantId,scopeId,ctx.principalId]);
    const cursorSchema=z.object({binding:z.string(),at:z.iso.datetime(),id:z.string().regex(/^knr_[a-f0-9]{32}$/),offset:z.number().int().min(0).max(MAX_SOURCE_BYTES),done:z.boolean()}).strict();
    let cursor:z.infer<typeof cursorSchema>|undefined;
    if(after){
      try{const bytes=Buffer.from(after,'base64url');if(bytes.toString('base64url')!==after)throw new Error('Noncanonical cursor');cursor=cursorSchema.parse(JSON.parse(bytes.toString()));}
      catch{throw new ApiError('INVALID_PAYLOAD','Shared fragment cursor is invalid');}
      requireCondition(cursor.binding===binding,'INVALID_PAYLOAD','Shared fragment cursor belongs to another identity or scope');
    }
    const rows=(await tx.query(`SELECT r.*,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM knowledge_records r JOIN knowledge_source_heads h ON h.record_id=r.record_id
      WHERE r.tenant_id=$1 AND r.scope_id=$2 AND r.owner_id=$3 AND r.kind='SourceRevision' AND r.knowledge_category='consolidated' AND r.source_type='shared-session'
      AND r.payload->'sharing'->>'allowed'='true'
      AND (r.payload->'acl'->'sourceReaders' ? $3 OR r.payload->'acl'->'sourceReaders' ? '*')
      AND (r.payload->'acl'->'platformReaders' ? $3 OR r.payload->'acl'->'platformReaders' ? '*')
      AND ($4::timestamptz IS NULL OR (r.created_at,r.record_id)>($4::timestamptz,$5::text)
        OR ($6::boolean AND (r.created_at,r.record_id)=($4::timestamptz,$5::text)))
      ORDER BY r.created_at,r.record_id LIMIT $7`,[ctx.tenantId,scopeId,ctx.principalId,cursor?.at??null,cursor?.id??null,cursor?!cursor.done:false,limit+1])).rows;
    const fragments=[],evidence=[],unmapped=[];
    let last:z.infer<typeof cursorSchema>|undefined,hasMore=false;
    for(let rowIndex=0;rowIndex<Math.min(rows.length,limit);rowIndex++){
      const row=rows[rowIndex];last={binding,at:row.cursor_time,id:row.record_id,offset:0,done:true};hasMore=rowIndex+1<rows.length;
      if(!await this.visible(ctx,row,tx))continue;const bytes=await this.objects.objects.getObject({Bucket:'evidence',Key:row.sha256});let value:any;
      requireCondition(sha256(bytes)===row.sha256,'SOURCE_HASH_MISMATCH','Shared source bytes differ from their SHA');
      try{value=JSON.parse(bytes.toString());}catch{unmapped.push({sourceRecordId:row.record_id,reason:'No structured synthetic fragments; semantic extraction was not run'});continue;}
      if(!Array.isArray(value?.fragments)){unmapped.push({sourceRecordId:row.record_id,reason:'Structured fragments are absent'});continue;}
      const quoted=await this.save(tx,ctx,'Evidence',scopeId,canonicalHash([row.record_id,0,bytes.length]),{sourceRecordId:row.record_id,start:0,end:bytes.length,sha256:row.sha256,text:bytes.toString(),path:row.payload.path},[row.record_id],{category:'consolidated',sourceType:'shared-session',visibility:'personal',state:'observed',digest:row.sha256});
      const ref={evidenceId:quoted.recordId,sha256:quoted.sha256};evidence.push(ref);
      let offset=cursor&&cursor.id===row.record_id&&!cursor.done?cursor.offset:0;
      requireCondition(offset<=value.fragments.length,'INVALID_PAYLOAD','Shared fragment cursor offset exceeds its source');
      while(offset<value.fragments.length&&fragments.length+unmapped.length<limit){const fragment=value.fragments[offset++];
        if(!fragment||typeof fragment.id!=='string'||!['fact','practice','correction'].includes(fragment.kind)||typeof fragment.quote!=='string'){unmapped.push({sourceRecordId:row.record_id,reason:'Fragment schema is not recognized'});continue;}
        fragments.push({...fragment,sourceRecordId:row.record_id,knowledgeCategory:'consolidated',sharingAllowed:true,evidence:[ref]});}
      last={...last,offset,done:offset===value.fragments.length};hasMore=hasMore||!last.done;
      if(fragments.length+unmapped.length===limit)break;
    }
    const nextCursor=last&&hasMore?Buffer.from(canonicalJson(last)).toString('base64url'):null;
    return {result:{fragments,unmapped,scope:'personal',sharing:'explicit-only',nextCursor},evidence};
  }
  async conflicts(ctx:AuthContext,claim:Row,tx?:Transaction):Promise<any[]>{
    const rows=(await (tx??this.store.pool).query(`SELECT * FROM knowledge_records WHERE kind='Claim' AND tenant_id=$1 AND scope_id=$2
      AND payload->>'subject'=$3 AND payload->>'predicate'=$4 AND record_id<>$5`,[claim.tenant_id,claim.scope_id,claim.payload.subject,claim.payload.predicate,claim.record_id])).rows;
    const results=[];for(const row of rows)if(canonicalHash(row.payload.conditions)===canonicalHash(claim.payload.conditions)&&canonicalHash(row.payload.value)!==canonicalHash(claim.payload.value)&&await this.visible(ctx,row,tx))results.push({recordId:row.record_id,knowledgeCategory:row.knowledge_category,status:'potential-conflict'});return results;
  }
  async requestReview(ctx:AuthContext,id:string,reviewerId:string):Promise<any>{return this.store.transaction(async tx=>{
    const row=await this.need(ctx,id,'Claim',tx);await this.auth.check(ctx,'knowledge.submit',row.scope_id,tx);requireCondition(row.owner_id===ctx.principalId,'FORBIDDEN_ACTION','Only the author requests review');
    const reviewer=await this.auth.policy({principalId:reviewerId} as AuthContext,tx);requireCondition(reviewer.tenantId===ctx.tenantId&&reviewer.scopes.includes(row.scope_id)&&reviewer.grants.includes('knowledge.review'),'FORBIDDEN_ACTION','Reviewer cannot review this scope');
    for(const source of (await this.closure(row,tx)).filter(r=>r.kind==='SourceRevision'&&r.knowledge_category==='consolidated'))requireCondition(source.payload.sharing?.teamPromotion===true,'SHARING_REQUIRED','Source consent does not permit sharing for team review');
    await tx.query('UPDATE knowledge_records SET reviewer_id=$2 WHERE record_id=$1',[id,reviewerId]);await this.auth.audit(ctx,'knowledge.request-review',{recordId:id,reviewerId},row.scope_id,tx);return {recordId:id,reviewerId};
  });}
  async reviewBundle(ctx:AuthContext,id:string,tx?:Transaction):Promise<any>{
    const row=await this.row(id,tx);if(!row||row.tenant_id!==ctx.tenantId)this.denied();await this.auth.check(ctx,'knowledge.review',row.scope_id,tx);
    if(row.reviewer_id!==ctx.principalId)this.denied();
    const owner={principalId:row.owner_id,tenantId:row.tenant_id,kind:'user'} as AuthContext;if(!await this.visible(owner,row,tx))this.denied();
    return {claim:this.view(row),records:(await this.closure(row,tx)).map(r=>this.view(r))};
  }
  async review(ctx:AuthContext,id:string,value:unknown):Promise<any>{const input=KnowledgeReviewInput.parse(value);return this.store.transaction(async tx=>{
    const row=await this.row(id,tx);if(!row||row.tenant_id!==ctx.tenantId)this.denied();
    requireCondition(row.owner_id!==ctx.principalId||!!input.productClaimId,'SELF_APPROVAL','The author cannot approve their own knowledge');
    await tx.query('SELECT 1 FROM knowledge_records WHERE record_id=$1 FOR UPDATE',[id]);
    const current=(await this.row(id,tx))!;requireCondition(current.state==='candidate','DECISION_CONFLICT','Knowledge candidate already has a decision');
    let assessor='human',questionVersion=input.ruleVersion;
    if(input.productClaimId){
      await this.auth.check(ctx,'knowledge.submit',row.scope_id,tx);requireCondition(row.owner_id===ctx.principalId&&input.decision==='approve','FORBIDDEN_ACTION','Product verification is requested by the candidate owner');
      const product=await this.need(ctx,input.productClaimId,'Claim',tx);
      requireCondition(product.knowledge_category==='product'&&['reviewed','verified'].includes(product.state)&&canonicalHash([product.payload.subject,product.payload.predicate,product.payload.value,product.payload.conditions])===canonicalHash([row.payload.subject,row.payload.predicate,row.payload.value,row.payload.conditions]),'ARTIFACT_VERIFICATION_FAILED','Product evidence does not match the proposed statement');
      assessor='script';questionVersion='exact-reviewed-product-match/1';
    }else await this.reviewBundle(ctx,id,tx);
    const closure=await this.closure(row,tx);
    if(input.promote)for(const source of closure.filter(r=>r.kind==='SourceRevision'&&r.knowledge_category==='consolidated'))requireCondition(source.payload.sharing?.teamPromotion===true,'SHARING_REQUIRED','Team promotion requires source consent');
    const state=input.decision==='approve'?(assessor==='script'?'verified':'reviewed'):'rejected';
    await tx.query('UPDATE knowledge_records SET state=$2,visibility=CASE WHEN $3 THEN \'team\' ELSE visibility END WHERE record_id=$1',[id,state,input.promote&&['reviewed','verified'].includes(state)]);
    if(input.promote&&state==='reviewed')await tx.query("UPDATE knowledge_records SET visibility='team' WHERE record_id=ANY($1::text[]) AND knowledge_category='consolidated'",[closure.map(r=>r.record_id)]);
    const payload={claimId:id,assessor,assessorId:ctx.principalId,questionVersion,...(assessor==='script'?{verification:{ruleId:'exact-product-match',ruleVersion:questionVersion,result:'passed'}}:{decision:input.decision}),reason:input.reason,productClaimId:input.productClaimId??null,checks:{references:'passed',semantic:assessor==='human'?'human-reviewed':'exact-equality-only'}};
    const assessment=await this.save(tx,ctx,'Assessment',row.scope_id,canonicalHash([id,payload]),payload,[id,...(input.productClaimId?[input.productClaimId]:[])],{category:row.knowledge_category,sourceType:row.source_type,visibility:input.promote?'team':row.visibility,state:'recorded'});
    const claim=this.view((await this.row(id,tx))!);
    const publisher={principalId:row.owner_id,tenantId:row.tenant_id,kind:'user'} as AuthContext;
    const snapshot=input.decision==='approve'&&claim.visibility==='team'&&['reviewed','verified'].includes(claim.state)?await this.publishStable(tx,publisher,row.scope_id,row.knowledge_category,null,false):undefined;
    await this.auth.audit(ctx,'knowledge.review',{recordId:id,assessmentId:assessment.recordId,state,promote:input.promote,...(snapshot?{snapshotId:snapshot.recordId}:{})},row.scope_id,tx);return {claim,assessment,...(snapshot?{snapshot}:{})};
  });}
  async publishStable(tx:Transaction,ctx:AuthContext,scopeId:string,knowledgeCategory:string,expectedSnapshotId:string|null,enforceExpected:boolean):Promise<any>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson(['stable',ctx.tenantId,scopeId,knowledgeCategory])]);
    const prior=(await tx.query('SELECT record_id FROM knowledge_stable WHERE tenant_id=$1 AND scope_id=$2 AND knowledge_category=$3',[ctx.tenantId,scopeId,knowledgeCategory])).rows[0]?.record_id??null;
    if(enforceExpected)requireCondition(prior===expectedSnapshotId,'INPUT_REVISION_STALE','Stable snapshot changed');
    const claims=(await tx.query("SELECT * FROM knowledge_records WHERE tenant_id=$1 AND scope_id=$2 AND knowledge_category=$3 AND kind='Claim' AND state IN ('reviewed','verified') AND visibility='team' ORDER BY record_id",[ctx.tenantId,scopeId,knowledgeCategory])).rows;
    const records=new Map<string,Row>();
    for(const claim of claims){if(!await this.visible(ctx,claim,tx))continue;for(const member of await this.closure(claim,tx))records.set(member.record_id,member);
      const assessments=(await tx.query("SELECT * FROM knowledge_records WHERE kind='Assessment' AND payload->>'claimId'=$1 ORDER BY record_id",[claim.record_id])).rows;
      for(const assessment of assessments)if(await this.visible(ctx,assessment,tx))for(const member of await this.closure(assessment,tx))records.set(member.record_id,member);
    }
    if(knowledgeCategory==='product')for(const claim of claims.filter(claim=>records.has(claim.record_id))){
      const closure=await this.closure(claim,tx),assessments=[...records.values()].filter(row=>row.kind==='Assessment'&&row.payload.claimId===claim.record_id);
      await tx.query(`INSERT INTO knowledge_active_statements(tenant_id,scope_id,statement_key,claim_id,source_ids,member_ids) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id,scope_id,statement_key) DO UPDATE SET claim_id=EXCLUDED.claim_id,source_ids=EXCLUDED.source_ids,member_ids=EXCLUDED.member_ids`,[ctx.tenantId,scopeId,canonicalHash([claim.owner_id,claim.payload.subject,claim.payload.predicate,claim.payload.conditions]),claim.record_id,closure.filter(row=>row.kind==='SourceRevision').map(row=>row.record_id),[...closure,...assessments].map(row=>row.record_id)]);
    }
    const members=[...records.values()].sort((a,b)=>a.record_id.localeCompare(b.record_id)).map(r=>({recordId:r.record_id,kind:r.kind,sha256:r.sha256,knowledgeCategory:r.knowledge_category,sourceType:r.source_type}));
    const canonicalManifest=canonicalJson({schemaVersion:'knowledge/1',knowledgeCategory,records:members}),digest=sha256(canonicalManifest);
    const snapshot=await this.save(tx,ctx,'KnowledgeSnapshot',scopeId,digest,{records:members,canonicalManifest,checks:{referenceClosure:'passed',candidateExclusion:'passed',semanticCompleteness:'not-asserted'}},members.map(r=>r.recordId),{
      category:knowledgeCategory,sourceType:'reviewed-records',visibility:'team',state:'published',digest});
    await tx.query(`INSERT INTO knowledge_stable(tenant_id,scope_id,knowledge_category,record_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,scope_id,knowledge_category) DO UPDATE SET record_id=EXCLUDED.record_id`,[ctx.tenantId,scopeId,knowledgeCategory,snapshot.recordId]);return snapshot;
  }
  async snapshot(ctx:AuthContext,value:unknown):Promise<any>{const input=KnowledgeSnapshotInput.parse(value);return this.store.transaction(async tx=>{
    await this.auth.check(ctx,'knowledge.publish',input.scopeId,tx);return this.publishStable(tx,ctx,input.scopeId,input.knowledgeCategory,input.expectedSnapshotId,true);
  });}
  async publishApprovedText(tx:Transaction,ctx:AuthContext,scopeId:string,body:{requestId:string;title:string;summary:string;text:string;fileName:string}):Promise<{recordId:string;snapshotId:string}>{
    const bytes=Buffer.from(body.text,'utf8'),digest=sha256(bytes);await this.objects.objects.putObject({Bucket:'evidence',Key:digest,Body:bytes});
    const stored=(await tx.query(`INSERT INTO sources(source_revision_id,tenant_id,scope_id,principal_id,sha256,size,object_key,file_name) VALUES($1,$2,$3,$4,$5,$6,$5,$7)
      ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,[newId('src'),ctx.tenantId,scopeId,ctx.principalId,digest,bytes.length,body.fileName])).rows[0];
    const sourceId=`governance:${body.requestId}`,sourceIdentity=canonicalHash([sourceId,'consolidated',ctx.principalId]),payload={sourceId,sourceIdentity,revision:digest,path:`/${body.fileName}`,parserVersion:'governance-approval/1',fileName:body.fileName,mediaType:'text/plain',acl:{sourceReaders:['*'],platformReaders:['*']},sharing:{allowed:true,teamPromotion:true},raw:{...this.objects.sourceReference(stored),fileName:body.fileName}};
    const source=await this.save(tx,ctx,'SourceRevision',scopeId,canonicalHash([sourceIdentity,digest]),payload,[],{category:'consolidated',sourceType:'document',visibility:'team',state:'observed',digest});
    await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,scope_id,identity_key) DO UPDATE SET record_id=EXCLUDED.record_id`,[ctx.tenantId,scopeId,sourceIdentity,source.recordId]);
    const evidence=await this.save(tx,ctx,'Evidence',scopeId,canonicalHash([source.recordId,digest]),{sourceRecordId:source.recordId,start:0,end:bytes.length,sha256:digest,text:body.text,path:payload.path,fileName:body.fileName,mediaType:'text/plain'},[source.recordId],{category:'consolidated',sourceType:'document',visibility:'team',state:'observed',digest});
    const claim=await this.save(tx,ctx,'Claim',scopeId,canonicalHash(['governance-claim',body.requestId]),{subject:body.title,predicate:'approved-text',value:body.text,conditions:{},evidenceIds:[evidence.recordId],sourcePaths:[payload.path],summary:body.summary},[source.recordId,evidence.recordId],{category:'consolidated',sourceType:'document',visibility:'team',state:'reviewed',searchText:[body.title,body.summary,body.text].join(' ')});
    const snapshot=await this.publishStable(tx,ctx,scopeId,'consolidated',null,false);return {recordId:claim.recordId,snapshotId:snapshot.recordId};
  }
  async search(ctx:AuthContext,query:{q:string;mode:string;limit:number;includeCandidates:string}):Promise<any>{return this.store.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const p=await this.auth.check(ctx,'knowledge.read',undefined,tx);
    const rows=(await tx.query(`SELECT r.*,s.record_id AS snapshot_id FROM knowledge_records r
      LEFT JOIN knowledge_stable s ON s.tenant_id=r.tenant_id AND s.scope_id=r.scope_id AND s.knowledge_category=r.knowledge_category
      LEFT JOIN knowledge_records snapshot ON snapshot.record_id=s.record_id
      WHERE r.tenant_id=$1 AND r.scope_id=ANY($2::text[]) AND r.kind='Claim'
      AND (r.record_id=ANY(snapshot.reference_ids) OR ($3 AND r.state='candidate'))
      AND CASE $4 WHEN 'exact' THEN r.payload->>'subject'=$5
        WHEN 'prefix' THEN left(r.payload->>'subject',length($5))=$5
        WHEN 'directory' THEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.payload->'sourcePaths') p WHERE left(p,length($5))=$5)
        ELSE ($5='' OR to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$5) OR position($5 in r.search_text)>0) END
      ORDER BY CASE r.knowledge_category WHEN 'product' THEN 0 ELSE 1 END,r.created_at DESC,r.record_id DESC`,[p.tenantId,p.scopes,query.includeCandidates==='true',query.mode,query.q])).rows;
    const visible:Row[]=[];for(const row of rows)if(await this.visible(ctx,row,tx))visible.push(row);
    const items=[];for(const row of visible.slice(0,query.limit))items.push({...this.view(row),snapshotId:row.state==='candidate'?null:row.snapshot_id,conflicts:await this.conflicts(ctx,row,tx)});
    return {items,total:visible.length,coverage:{authorizedScopes:p.scopes,retrieval:query.mode,missingEvidence:'No hit does not establish absence'}};
  });}
  async checkSourceAccess(ctx:AuthContext,sourceId:string,tx?:Transaction,pin?:SourceAccessPin):Promise<void>{
    const rows=(await (tx??this.store.pool).query("SELECT * FROM knowledge_records WHERE kind='SourceRevision' AND payload->'raw'->>'sourceRevisionId'=$1",[sourceId])).rows;
    if(!rows.length)return;
    for(const row of rows)if(await this.visible(ctx,row,tx,pin)||await this.ownerReadable(ctx,row,tx))return;
    await this.noteDenied(ctx,rows.find(row=>row.tenant_id===ctx.tenantId));
    this.denied();
  }
}
