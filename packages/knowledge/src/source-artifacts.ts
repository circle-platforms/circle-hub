import {ApiError,SourceArtifactRegistration,SourceArtifactConfiguration,AssetId,SourceArtifactId,SourceRevisionId,KnowledgeRecordId,Sha256,SafeRelativePath,MAX_SOURCE_BYTES,canonicalHash,requireCondition,sha256,type AuthContext,type AssetRegistration} from '../../contracts/src/index.ts';
import {z} from 'zod';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {Knowledge} from './index.ts';
import type {KnowledgeGraph} from './graph.ts';

const file=z.object({path:SafeRelativePath,role:z.string(),mediaType:z.string(),sourceRevisionId:SourceRevisionId,sha256:Sha256,size:z.number().int().positive(),sourceRecordId:KnowledgeRecordId});
const configuration=z.object({schema:z.literal('external-source-artifact/1'),sourceArtifactId:SourceArtifactId,metadata:z.record(z.string(),z.unknown()),files:z.array(file).min(1).max(100)}).strict();
export interface SourceArtifactSnapshot{sourceArtifactId:string;assetId:string;assetVersion:string;assetSha256:string;metadata:Record<string,any>;files:z.infer<typeof file>[]}
// The platform binds opaque originals and declared metadata. Consumers interpret
// formats; independent asset approval does not certify semantic correctness.
export class SourceArtifacts{
  store:Store;auth:Auth;assets:Assets;originals:Knowledge;graph:KnowledgeGraph;
  constructor(store:Store,auth:Auth,assets:Assets,originals:Knowledge,graph:KnowledgeGraph){this.store=store;this.auth=auth;this.assets=assets;this.originals=originals;this.graph=graph;}
  external(id:unknown):id is string{return typeof id==='string'&&/^sar_[a-f0-9]{32}$/.test(id);}
  async original(ctx:AuthContext,input:any,scope:string,tx:Transaction){
    let record:any;if(input.sourceRecordId){record=await this.graph.get(ctx,input.sourceRecordId,tx);requireCondition(record.kind==='SourceRevision'&&record.knowledgeCategory==='product','INVALID_PAYLOAD','Bind an original product SourceRevision, not a candidate claim');requireCondition(record.scopeId===scope,'FORBIDDEN_SCOPE','Original is outside the artifact scope');}
    const result=await this.originals.sourceBytes(ctx,input.sourceRevisionId??record.payload.raw.sourceRevisionId,scope,tx);requireCondition(!input.sha256||input.sha256===result.reference.sha256,'SOURCE_HASH_MISMATCH','Original differs from the declared SHA');
    const row=(await tx.query('SELECT principal_id FROM sources WHERE source_revision_id=$1',[result.reference.sourceRevisionId])).rows[0];requireCondition(record||row.principal_id===ctx.principalId,'FORBIDDEN_ACTION','Register your own upload or an authorized product source record');return {...result,originalRecordId:record?.recordId};
  }
  async register(ctx:AuthContext,value:unknown){
    const input=SourceArtifactRegistration.parse(value),assetId=`ast_${canonicalHash([ctx.tenantId,input.scopeId,ctx.principalId,input.name]).slice(0,32)}`;
    return this.view(await this.assets.register(ctx,{assetId,scopeId:input.scopeId,kind:'knowledge-source',name:input.name,version:input.version,declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{schema:'external-source-artifact/1',metadata:input.metadata,files:input.files},readers:input.readers}));
  }
  async prepare(ctx:AuthContext,definition:AssetRegistration,assetId:string,tx:Transaction):Promise<AssetRegistration>{
    if(definition.configuration.schema!=='external-source-artifact/1')return definition;
    requireCondition(definition.kind==='knowledge-source'&&definition.declaration.reads.includes('registered-source')&&!definition.declaration.writes.length&&!definition.declaration.credentials.length,'INVALID_PAYLOAD','External originals require a read-only knowledge-source declaration');
    const input=SourceArtifactConfiguration.parse(definition.configuration);await this.auth.check(ctx,'knowledge.read',definition.scopeId,tx);
    const originals=[];let total=0;for(const entry of input.files){const original=await this.original(ctx,entry,definition.scopeId,tx);total+=original.bytes.length;requireCondition(total<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Source artifact originals exceed sixteen MiB');originals.push({entry,original});}
    const readers=[...new Set([ctx.principalId,...definition.readers??[]])],files=[];
    const replay=!!(await tx.query('SELECT 1 FROM asset_versions WHERE asset_id=$1 AND version=$2',[assetId,definition.version])).rowCount;
    for(const {entry,original} of originals){
      const sourceIdentity=canonicalHash(['external-source-artifact',assetId,entry.path]),path=`/${entry.path}`;
      const payload={sourceId:`external-source-artifact:${assetId}:${entry.path}`,sourceIdentity,revision:`${definition.version}:${original.reference.sha256}`,path,parserVersion:'external-source-artifact/1',acl:{sourceReaders:readers,platformReaders:readers},sharing:null,asset:{assetId,permission:'sources.read'},raw:original.reference};
      const source=await this.graph.save(tx,ctx,'SourceRevision',definition.scopeId,canonicalHash([sourceIdentity,definition.version,original.reference.sha256]),payload,original.originalRecordId?[original.originalRecordId]:[],{category:'product',sourceType:'external-artifact',visibility:'team',state:'observed',digest:original.reference.sha256});
      if(!replay)await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,scope_id,identity_key) DO UPDATE SET record_id=EXCLUDED.record_id,generation=knowledge_source_heads.generation+CASE WHEN knowledge_source_heads.record_id=EXCLUDED.record_id THEN 0 ELSE 1 END`,[ctx.tenantId,definition.scopeId,sourceIdentity,source.recordId]);
      files.push({path:entry.path,role:entry.role,mediaType:entry.mediaType,sourceRevisionId:original.reference.sourceRevisionId,sha256:original.reference.sha256,size:original.bytes.length,sourceRecordId:source.recordId});
    }
    const sourceArtifactId=`sar_${canonicalHash([assetId,definition.version,input.metadata,files]).slice(0,32)}`;
    return {...definition,configuration:{schema:'external-source-artifact/1',sourceArtifactId,metadata:input.metadata,files},readers};
  }
  view(asset:any){const source=configuration.parse(asset.configuration),approved=['approved','running'].includes(asset.lifecycle)&&(!('approved_digest' in asset)||asset.approved_digest===asset.sha256);return {assetId:asset.assetId??asset.asset_id,scopeId:asset.scopeId??asset.scope_id,version:asset.version,sha256:asset.sha256,lifecycle:asset.lifecycle,sourceArtifactId:approved?source.sourceArtifactId:null,metadata:source.metadata,files:source.files,provenance:{kind:'user-upload',semanticQuality:'not-asserted'}};}
  async get(ctx:AuthContext,id:string){const asset=await this.assets.row(ctx,id);requireCondition(asset.kind==='knowledge-source'&&asset.configuration.schema==='external-source-artifact/1','INVALID_PAYLOAD','Asset is not an external source artifact');return this.view(asset);}
  async validate(ctx:AuthContext,definition:any,id:string,tx:Transaction){
    if(definition.configuration.schema!=='external-source-artifact/1')return;
    requireCondition(definition.kind==='knowledge-source','INVALID_PAYLOAD','External artifact requires a knowledge-source asset');const source=configuration.parse(definition.configuration);
    for(const entry of source.files){const record=await this.graph.get(ctx,entry.sourceRecordId,tx);requireCondition(record.kind==='SourceRevision'&&record.knowledgeCategory==='product'&&record.payload.asset?.assetId===id&&record.sha256===entry.sha256&&record.payload.raw.sourceRevisionId===entry.sourceRevisionId,'INVALID_PAYLOAD','Registered asset must bind its authorized originals');requireCondition(record.scopeId===definition.scopeId,'FORBIDDEN_SCOPE','Original crosses the artifact scope');}
  }
  async snapshot(ctx:AuthContext,id:string,scope?:string,tx?:Transaction):Promise<SourceArtifactSnapshot>{
    const asset=await this.assets.row(ctx,id,tx);requireCondition(!scope||asset.scope_id===scope,'FORBIDDEN_SCOPE','Source artifact is outside the execution partition');requireCondition(asset.kind==='knowledge-source'&&asset.configuration.schema==='external-source-artifact/1','INVALID_PAYLOAD','Asset is not an external source artifact');requireCondition(['approved','running'].includes(asset.lifecycle)&&asset.approved_digest===asset.sha256,'APPROVAL_REQUIRED','Source artifact needs current independent approval');
    const source=configuration.parse(asset.configuration);for(const entry of source.files){const record=await this.graph.get(ctx,entry.sourceRecordId,tx);requireCondition(record.kind==='SourceRevision'&&record.sha256===entry.sha256&&record.payload.asset?.assetId===id,'SOURCE_HASH_MISMATCH','Registered source binding differs');await this.originals.source(ctx,entry.sourceRevisionId,asset.scope_id,tx);}
    return {sourceArtifactId:source.sourceArtifactId,assetId:id,assetVersion:asset.version,assetSha256:asset.sha256,metadata:source.metadata,files:source.files};
  }
  async resolve(ctx:AuthContext,id:string,scope:string,tx?:Transaction){
    const p=await this.auth.policy(ctx,tx),rows=(await (tx??this.store.pool).query(`SELECT a.asset_id,v.version FROM assets a JOIN asset_versions v USING(asset_id) WHERE a.tenant_id=$1 AND a.scope_id=ANY($2::text[]) AND a.kind='knowledge-source' AND v.configuration->>'sourceArtifactId'=$3 AND (a.owner_principal_id=$4 OR v.readers ? $4 OR v.readers ? '*')`,[p.tenantId,p.scopes,id,ctx.principalId])).rows;
    if(rows.length!==1)throw new ApiError('SOURCE_FORBIDDEN','Source artifact is not available to this identity');const asset=await this.assets.row(ctx,rows[0].asset_id,tx);requireCondition(asset.version===rows[0].version&&asset.configuration.sourceArtifactId===id,'APPROVAL_STALE','Requested source artifact version was replaced');return this.snapshot(ctx,asset.asset_id,scope,tx);
  }
  async bytes(ctx:AuthContext,snapshot:SourceArtifactSnapshot,scope:string,tx?:Transaction){
    const originals=[];for(const entry of snapshot.files){const original=await this.originals.sourceBytes(ctx,entry.sourceRevisionId,scope,tx);requireCondition(original.reference.sha256===entry.sha256&&sha256(original.bytes)===entry.sha256,'SOURCE_HASH_MISMATCH','Registered original bytes differ');originals.push({path:`/${entry.path}`,bytes:original.bytes,sha256:entry.sha256,mediaType:entry.mediaType,etag:null,sourceType:'external-artifact'});}return originals;
  }
  async reference(ctx:AuthContext,namespace:string,selector:string){
    const p=await this.auth.check(ctx,'sources.read'),rows=(await this.store.pool.query(`SELECT a.asset_id FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version
      WHERE a.tenant_id=$1 AND a.scope_id=ANY($2::text[]) AND a.kind='knowledge-source' AND v.configuration->>'schema'='external-source-artifact/1'
      AND (a.owner_principal_id=$3 OR v.readers ? $3 OR v.readers ? '*')
      AND (v.configuration->>'sourceArtifactId'=$4 OR v.configuration->'metadata'->'bindings'->>$5=$4)`,[p.tenantId,p.scopes,p.principalId,selector,namespace])).rows;
    requireCondition(rows.length,'SOURCE_FORBIDDEN','Source artifact is not available to this identity');requireCondition(rows.length===1,'INVALID_PAYLOAD','Registered selector is ambiguous; use a sourceArtifactId');return this.snapshot(ctx,rows[0].asset_id);
  }
  async bundle(ctx:AuthContext,selector:string){const source=await this.reference(ctx,'build',selector);return {sourceArtifactId:source.sourceArtifactId,assetId:source.assetId,version:source.assetVersion,sha256:source.assetSha256,entries:source.files.map(file=>({path:file.path,sha256:file.sha256,size:file.size,mediaType:file.mediaType}))};}
  async blob(ctx:AuthContext,digest:string){
    Sha256.parse(digest);const p=await this.auth.check(ctx,'sources.read'),rows=(await this.store.pool.query(`SELECT a.asset_id,a.scope_id FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version
      WHERE a.tenant_id=$1 AND a.scope_id=ANY($2::text[]) AND a.kind='knowledge-source' AND v.configuration->>'schema'='external-source-artifact/1'
      AND v.lifecycle IN ('approved','running') AND v.approved_digest=v.sha256 AND (a.owner_principal_id=$3 OR v.readers ? $3 OR v.readers ? '*')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.configuration->'files') f WHERE f->>'sha256'=$4)`,[p.tenantId,p.scopes,p.principalId,digest])).rows;
    for(const row of rows){try{const source=await this.snapshot(ctx,row.asset_id),file=source.files.find(file=>file.sha256===digest)!;const original=await this.originals.sourceBytes(ctx,file.sourceRevisionId,row.scope_id);requireCondition(original.reference.sha256===digest&&sha256(original.bytes)===digest,'SOURCE_HASH_MISMATCH','Source blob bytes differ');return {bytes:original.bytes,reference:{sha256:digest,mediaType:file.mediaType,fileName:file.path.split('/').at(-1)}};}catch(error){if(!(error instanceof ApiError)||!['SOURCE_FORBIDDEN','FORBIDDEN_ACTION','ASSET_NOT_VISIBLE','APPROVAL_REQUIRED'].includes(error.code))throw error;}}
    throw new ApiError('SOURCE_FORBIDDEN','Source blob is not available to this identity');
  }
  async capture(tx:Transaction,ctx:AuthContext,scope:string,snapshot:SourceArtifactSnapshot,raw:any,permission:string){
    const entry=snapshot.files.find(entry=>`/${entry.path}`===(raw.artifactFilePath??raw.path)),bytes=Buffer.from(raw.contentBase64,'base64');requireCondition(entry&&entry.sha256===raw.sha256&&bytes.length===entry.size&&sha256(bytes)===entry.sha256,'SOURCE_HASH_MISMATCH','Tool receipt exceeds its approved source artifact');
    await this.graph.get(ctx,entry.sourceRecordId,tx);const sourceIdentity=canonicalHash(['artifact-read',snapshot.assetId,ctx.principalId,raw.path,entry.path]),payload={sourceId:`artifact-read:${sourceIdentity}`,sourceIdentity,revision:entry.sha256,path:raw.path,parserVersion:'external-artifact-return/1',acl:{sourceReaders:[ctx.principalId],platformReaders:[ctx.principalId]},asset:{assetId:snapshot.assetId,permission},sourceArtifactId:snapshot.sourceArtifactId,origin:'uploaded-artifact',live:false,sharing:null,raw:await this.originals.source(ctx,entry.sourceRevisionId,scope,tx)};
    const source=await this.graph.save(tx,ctx,'SourceRevision',scope,canonicalHash([sourceIdentity,entry.sha256]),payload,[entry.sourceRecordId],{category:'product',sourceType:'external-artifact',visibility:'team',state:'observed',digest:entry.sha256});
    const previous=(await tx.query('SELECT record_id FROM knowledge_source_heads WHERE tenant_id=$1 AND scope_id=$2 AND identity_key=$3',[ctx.tenantId,scope,sourceIdentity])).rows[0]?.record_id;
    const head=(await tx.query(`INSERT INTO knowledge_source_heads(tenant_id,scope_id,identity_key,record_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,scope_id,identity_key) DO UPDATE SET record_id=EXCLUDED.record_id,generation=knowledge_source_heads.generation+CASE WHEN knowledge_source_heads.record_id=EXCLUDED.record_id THEN 0 ELSE 1 END RETURNING generation`,[ctx.tenantId,scope,sourceIdentity,source.recordId])).rows[0];
    const evidence=await this.graph.save(tx,ctx,'Evidence',scope,canonicalHash([source.recordId,0,bytes.length]),{sourceRecordId:source.recordId,start:0,end:bytes.length,sha256:entry.sha256,text:bytes.toString('utf8'),path:raw.path},[source.recordId],{category:'product',sourceType:'external-artifact',visibility:'team',state:'observed',digest:entry.sha256});
    return {evidenceId:evidence.recordId,sha256:evidence.sha256,sourceRecordId:source.recordId,generation:Number(head.generation),supersededSourceId:previous&&previous!==source.recordId?previous:null};
  }
}
