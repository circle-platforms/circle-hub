import {ApiError,canonicalHash,newId,requireCondition,type AuthContext,type AssetRegistration,AssetRegistration as Registration} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import {PrivateVault} from './vault.ts';

const join='assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version';
const visibility="a.tenant_id=$1 AND a.scope_id=ANY($2::text[]) AND (a.owner_principal_id=$3 OR v.readers ? $3 OR v.readers ? '*')";
const sensitive=/^(?:token|password|secret|authorization|cookie|jwt|privatekey|credentialvalue)$/i;
function clean(value:unknown):void{
  if(!value||typeof value!=='object')return;
  for(const [key,nested] of Object.entries(value)){requireCondition(!sensitive.test(key),'INVALID_PAYLOAD','Use a private credential reference');clean(nested);}
}
export class Assets {
  store:Store;auth:Auth;vault:PrivateVault;
  healthCheck?: (ctx:AuthContext,asset:any)=>Promise<{result:string;reason:string}>;
  constructor(store:Store,auth:Auth,directory:string){this.store=store;this.auth=auth;this.vault=new PrivateVault(directory);}
  binding(row:any):string{return JSON.stringify([row.tenant_id,row.scope_id,row.owner_principal_id,row.asset_id,row.version]);}
  view(row:any):any{return {assetId:row.asset_id,scopeId:row.scope_id,kind:row.kind,ownerPrincipalId:row.owner_principal_id,version:row.version,name:row.name,
    sha256:row.sha256,declaration:row.declaration,configuration:row.configuration,lifecycle:row.lifecycle,health:row.health};}
  async row(ctx:AuthContext,id:string,tx?:Transaction,grant='assets.read'):Promise<any>{
    const policy=await this.auth.check(ctx,grant,undefined,tx);
    const row=(await (tx??this.store.pool).query(`SELECT a.*,v.* FROM ${join} WHERE ${visibility} AND a.asset_id=$4`,[policy.tenantId,policy.scopes,policy.principalId,id])).rows[0];
    requireCondition(row,'ASSET_NOT_VISIBLE','Asset is not visible to the authenticated principal');return row;
  }
  async get(ctx:AuthContext,id:string):Promise<any>{return this.view(await this.row(ctx,id));}
  async list(ctx:AuthContext,query:{limit:number;after?:string;kind?:string}):Promise<any>{return this.store.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const p=await this.auth.check(ctx,'assets.read',undefined,tx),args=[p.tenantId,p.scopes,p.principalId,query.kind??null];
    const filter=`${visibility} AND ($4::text IS NULL OR a.kind=$4)`;
    const total=Number((await tx.query(`SELECT count(*) AS count FROM ${join} WHERE ${filter}`,args)).rows[0].count);
    const rows=(await tx.query(`SELECT a.*,v.* FROM ${join} WHERE ${filter} AND ($5::text IS NULL OR a.asset_id<$5) ORDER BY a.asset_id DESC LIMIT $6`,[...args,query.after??null,query.limit+1])).rows;
    const items=rows.slice(0,query.limit).map(row=>this.view(row));return {items,total,nextCursor:rows.length>query.limit?items.at(-1).assetId:null};
  });}
  async register(ctx:AuthContext,input:AssetRegistration,tx?:Transaction,credential=false):Promise<any>{
    const definition=Registration.parse(input);clean(definition.configuration);
    requireCondition(credential||definition.kind!=='credential-reference','INVALID_PAYLOAD','Register personal credentials through the write-only endpoint');
    const run=async(client:Transaction)=>{
      const p=await this.auth.check(ctx,'assets.register',definition.scopeId,client),owner=definition.ownerPrincipalId??p.principalId;
      requireCondition(owner===p.principalId,'FORBIDDEN_ACTION','A person registers only their own asset');
      const id=definition.assetId??newId('ast');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
      const existing=(await client.query('SELECT * FROM assets WHERE asset_id=$1',[id])).rows[0];
      requireCondition(!existing||existing.tenant_id===p.tenantId&&existing.scope_id===definition.scopeId&&existing.owner_principal_id===owner&&existing.kind===definition.kind,'FORBIDDEN_ACTION','Asset ownership and partition cannot be reassigned');
      const readers=credential?[owner]:definition.readers??[owner];
      const digest=canonicalHash({scopeId:definition.scopeId,kind:definition.kind,owner,name:definition.name,version:definition.version,declaration:definition.declaration,configuration:definition.configuration,readers});
      const old=(await client.query('SELECT * FROM asset_versions WHERE asset_id=$1 AND version=$2',[id,definition.version])).rows[0];
      if(old){requireCondition(old.sha256===digest,'IDEMPOTENCY_MISMATCH','An asset version is immutable');return {...this.view({...existing,...old}),deduplicated:true};}
      if(!existing)await client.query('INSERT INTO assets(asset_id,tenant_id,scope_id,kind,owner_principal_id,current_version) VALUES($1,$2,$3,$4,$5,$6)',[id,p.tenantId,definition.scopeId,definition.kind,owner,definition.version]);
      await client.query('INSERT INTO asset_versions(asset_id,version,sha256,name,declaration,configuration,readers) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,definition.version,digest,definition.name,JSON.stringify(definition.declaration),JSON.stringify(definition.configuration),JSON.stringify(readers)]);
      await client.query('UPDATE assets SET current_version=$2 WHERE asset_id=$1',[id,definition.version]);
      await this.auth.audit(ctx,'assets.register',{assetId:id,version:definition.version,sha256:digest,kind:definition.kind},definition.scopeId,client);
      return {...this.view((await client.query(`SELECT a.*,v.* FROM ${join} WHERE a.asset_id=$1`,[id])).rows[0]),deduplicated:false};
    };return tx?run(tx):this.store.transaction(run);
  }
  async transition(ctx:AuthContext,id:string,input:{version:string;sha256:string;state:string}):Promise<any>{return this.store.transaction(async tx=>{
    await this.row(ctx,id,tx);await tx.query('SELECT 1 FROM assets WHERE asset_id=$1 FOR UPDATE',[id]);const row=await this.row(ctx,id,tx);
    requireCondition(row.version===input.version&&row.sha256===input.sha256,'APPROVAL_STALE','Asset version or digest differs');
    if(input.state==='approved'){
      requireCondition(row.owner_principal_id!==ctx.principalId,'SELF_APPROVAL','An owner cannot approve their own asset');await this.auth.check(ctx,'assets.approve',row.scope_id,tx);
      requireCondition(row.lifecycle==='draft','DECISION_CONFLICT','Only a draft can be approved');
      await tx.query("UPDATE asset_versions SET lifecycle='approved',approved_by=$3,approved_digest=$4 WHERE asset_id=$1 AND version=$2",[id,row.version,ctx.principalId,row.sha256]);
    }else{
      await this.auth.check(ctx,'assets.change',row.scope_id,tx);requireCondition(row.owner_principal_id===ctx.principalId,'FORBIDDEN_ACTION','Only the owner changes asset activity');
      if(input.state==='running')requireCondition(['approved','running'].includes(row.lifecycle)&&row.approved_digest===row.sha256,'APPROVAL_REQUIRED','This version needs a bound approval');
      else requireCondition(input.state==='disabled','DECISION_CONFLICT','Use a new version to edit an asset');
      await tx.query('UPDATE asset_versions SET lifecycle=$3 WHERE asset_id=$1 AND version=$2',[id,row.version,input.state]);
    }
    await this.auth.audit(ctx,'assets.lifecycle',{assetId:id,version:row.version,sha256:row.sha256,state:input.state},row.scope_id,tx);
    return this.view((await tx.query(`SELECT a.*,v.* FROM ${join} WHERE a.asset_id=$1`,[id])).rows[0]);
  });}
  async credential(ctx:AuthContext,id:string,input:{version:string;value:string;ownerPrincipalId?:string}):Promise<any>{
    const parent=await this.row(ctx,id);await this.auth.check(ctx,'credentials.register',parent.scope_id);
    requireCondition(ctx.kind==='user'&&parent.kind==='connector-instance'&&parent.owner_principal_id===ctx.principalId&&(!input.ownerPrincipalId||input.ownerPrincipalId===ctx.principalId),'FORBIDDEN_ACTION','Only the owner binds their own personal credential');
    const assetId=newId('ast'),binding=JSON.stringify([parent.tenant_id,parent.scope_id,ctx.principalId,assetId,input.version]);
    const key=await this.vault.put(input.value,binding);
    try{return await this.store.transaction(async tx=>{
      const asset=await this.register(ctx,{assetId,scopeId:parent.scope_id,kind:'credential-reference',name:'Personal connector credential',version:input.version,
        declaration:{reads:[],writes:[],credentials:[]},configuration:{connectorAssetId:id},readers:[ctx.principalId]},tx,true);
      await tx.query('INSERT INTO personal_credentials(asset_id,version,connector_asset_id,secret_key) VALUES($1,$2,$3,$4)',[assetId,input.version,id,key]);return asset;
    });}catch(error){await this.vault.remove(key);throw error;}
  }
  async executionValue(ctx:AuthContext,reference:string,connectorId:string):Promise<string>{
    const row=await this.row(ctx,reference,undefined,'credentials.use');
    requireCondition(row.kind==='credential-reference'&&row.owner_principal_id===ctx.principalId&&row.lifecycle!=='disabled','FORBIDDEN_ACTION','Personal credential is not available to this execution identity');
    const link=(await this.store.pool.query('SELECT * FROM personal_credentials WHERE asset_id=$1 AND version=$2',[row.asset_id,row.version])).rows[0];
    requireCondition(link&&link.connector_asset_id===connectorId,'FORBIDDEN_ACTION','Credential is bound to another connector');return this.vault.get(link.secret_key,this.binding(row));
  }
  async check(ctx:AuthContext,id:string):Promise<any>{
    const row=await this.row(ctx,id);await this.auth.check(ctx,'assets.check',row.scope_id);
    let result={result:'unknown',reason:'checker-not-registered'};
    if(row.kind==='credential-reference'){
      try{await this.executionValue(ctx,id,row.configuration.connectorAssetId);result={result:'available',reason:'local-secret-ready'};}catch{result={result:'unavailable',reason:'local-secret-unavailable'};}
    }else if(this.healthCheck){try{result=await this.healthCheck(ctx,this.view(row));}catch{result={result:'unavailable',reason:'checker-failed'};}}
    const health={checkedAt:new Date().toISOString(),...result};
    await this.store.transaction(async tx=>{await tx.query('UPDATE asset_versions SET health=$3 WHERE asset_id=$1 AND version=$2',[id,row.version,JSON.stringify(health)]);await this.auth.audit(ctx,'assets.health',{assetId:id,version:row.version,health},row.scope_id,tx);});
    return {...this.view(row),health};
  }
}
