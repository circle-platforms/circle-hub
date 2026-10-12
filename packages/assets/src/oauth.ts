import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ApiError,OAuthGrantInput,canonicalHash,newId,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import {privateHttp,resolveTrust} from '../../connectors/src/private-http.ts';
import type {Assets} from './index.ts';
import type {Store} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import {OAuthToken} from './oauth-token.ts';

export const OAuthProfile=z.object({issuer:z.string().url(),tokenEndpoint:z.string().url(),deviceAuthorizationEndpoint:z.string().url().optional(),clientId:z.string().min(1).max(500),clientAuthentication:z.enum(['none','client_secret_basic','client_secret_post']).default('none'),scope:z.string().max(1000).default(''),accessTtlSeconds:z.number().int().positive().optional(),caFile:z.string().optional(),caSha256:z.string().optional(),timeoutMs:z.number().int().min(100).max(120000).default(30000)}).strict();
export type OAuthProfile=z.infer<typeof OAuthProfile>;
export function tokenBundle(body:any,profile:OAuthProfile,previous?:any){
  let token:any;try{token=z.object({access_token:z.string().min(1),token_type:z.string(),expires_in:z.number().int().positive().optional(),refresh_token:z.string().min(1).optional(),scope:z.string().optional()}).parse(body);if(token.token_type.toLowerCase()!=='bearer')throw new Error();}catch{throw new ApiError('SOURCE_UNREACHABLE','OAuth endpoint did not return a supported token receipt');}
  const lifetime=token.expires_in??profile.accessTtlSeconds;return {access_token:token.access_token,token_type:'Bearer',expires_at:lifetime?Date.now()/1000+lifetime:null,...(token.refresh_token??previous?.refresh_token?{refresh_token:token.refresh_token??previous.refresh_token}:{}),scope:token.scope??previous?.scope??profile.scope,server:profile.issuer};
}
export async function oauthRequest(profile:OAuthProfile,endpoint:string,fields:Record<string,string>,clientSecret?:string){
  const body=new URLSearchParams(fields),headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded'};
  if(profile.clientAuthentication==='client_secret_basic'){requireCondition(clientSecret,'SOURCE_LOGIN_EXPIRED','OAuth client needs its private client credential reference');headers.authorization=`Basic ${Buffer.from(`${encodeURIComponent(profile.clientId)}:${encodeURIComponent(clientSecret!)}`).toString('base64')}`;}
  else{body.set('client_id',profile.clientId);if(profile.clientAuthentication==='client_secret_post'){requireCondition(clientSecret,'SOURCE_LOGIN_EXPIRED','OAuth client needs its private client credential reference');body.set('client_secret',clientSecret!);}}
  return privateHttp(new URL(endpoint),{...profile,body:body.toString(),headers});
}
export class OAuthCredentials{
  store:Store;auth:Auth;assets:Assets;file?:string;
  constructor(store:Store,auth:Auth,assets:Assets,file?:string){this.store=store;this.auth=auth;this.assets=assets;this.file=file;}
  async profile(ref:string){
    let profile:OAuthProfile;try{const all=z.object({profiles:z.record(z.string(),OAuthProfile)}).strict().parse(JSON.parse(await readFile(this.file??'','utf8')));profile=all.profiles[ref];if(!profile)throw new Error();}catch{throw new ApiError('SOURCE_UNREACHABLE','OAuth issuer profile is not configured');}
    for(const endpoint of [profile.issuer,profile.tokenEndpoint,profile.deviceAuthorizationEndpoint].filter(Boolean)){const url=new URL(endpoint!);requireCondition(!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)),'INVALID_PAYLOAD','Remote OAuth issuer endpoints require TLS');}
    const trust=await resolveTrust(profile);return {...profile,...(trust.caSha256?{caSha256:trust.caSha256}:{})};
  }
  async owner(ctx:AuthContext,input:any){
    const parent=await this.assets.row(ctx,input.connectorAssetId);await this.auth.check(ctx,'credentials.register',parent.scope_id);requireCondition(ctx.kind==='user'&&parent.kind==='connector-instance'&&parent.owner_principal_id===ctx.principalId,'FORBIDDEN_ACTION','Only the connector owner starts its OAuth grant');requireCondition(parent.version===input.connectorVersion&&parent.lifecycle!=='disabled','APPROVAL_STALE','OAuth connector revision changed');requireCondition(parent.configuration.oauthProfileRef===input.profileRef,'FORBIDDEN_ACTION','OAuth issuer is not bound to this connector');return parent;
  }
  async secret(ctx:AuthContext,connectorId:string,reference?:string){
    if(!reference)return undefined;const value=await this.assets.executionValue(ctx,reference,connectorId);try{const client=z.object({client_id:z.string().optional(),client_secret:z.string().min(1)}).parse(JSON.parse(value));return client;}catch{throw new ApiError('SOURCE_LOGIN_EXPIRED','Register an owned private OAuth client credential JSON');}
  }
  view(row:any){return {flowId:row.flow_id,status:row.state==='creating'||row.state==='exchanging'?'unknown':row.state,...row.metadata,intervalSeconds:row.interval_seconds,expiresAt:row.expires_at?.toISOString()??null,...(row.credential_asset_id?{credentialAssetId:row.credential_asset_id}:{})};}
  binding(row:any){return JSON.stringify(['oauth-flow',row.tenant_id,row.scope_id,row.owner_id,row.flow_id]);}
  async complete(ctx:AuthContext,row:any,profile:OAuthProfile,receipt:any){
    const saved=JSON.parse(await this.assets.vault.get(row.secret_key,this.binding(row))),tokens=saved.bundle??tokenBundle(receipt,profile);if(!saved.bundle)await this.assets.vault.replace(row.secret_key,JSON.stringify({...saved,bundle:tokens}),this.binding(row));
    const credential=await this.assets.credential(ctx,row.connector_asset_id,{version:'1.0.0',value:JSON.stringify(tokens)},{oauth:{profileRef:row.profile_ref,profileDigest:row.profile_digest,grantType:row.grant_type,...(row.metadata.clientCredentialId?{clientCredentialId:row.metadata.clientCredentialId}:{})}},`ast_${canonicalHash([row.tenant_id,row.scope_id,row.owner_id,row.flow_id,'oauth-credential']).slice(0,32)}`);
    const completed=(await this.store.pool.query("UPDATE oauth_flows SET state='authorized',credential_asset_id=$2,metadata=metadata || $3::jsonb WHERE flow_id=$1 RETURNING *",[row.flow_id,credential.assetId,JSON.stringify({tokenExpiresAt:tokens.expires_at?new Date(tokens.expires_at*1000).toISOString():null})])).rows[0];await this.auth.audit(ctx,'credentials.oauth-authorized',{flowId:row.flow_id,credentialAssetId:credential.assetId,grantType:row.grant_type},row.scope_id);return this.view(completed);
  }
  async credentialProfile(ctx:AuthContext,row:any){
    if(!row.configuration.oauth)return undefined;const meta=row.configuration.oauth,profile=await this.profile(meta.profileRef);requireCondition(canonicalHash(profile)===meta.profileDigest,'APPROVAL_STALE','OAuth credential issuer profile changed');let clientReference:any;
    if(meta.clientCredentialId){const client=await this.assets.row(ctx,meta.clientCredentialId,undefined,'credentials.use');requireCondition(client.owner_principal_id===ctx.principalId&&client.lifecycle!=='disabled'&&client.configuration.connectorAssetId===row.configuration.connectorAssetId&&!client.configuration.oauth,'FORBIDDEN_ACTION','OAuth client credential reference differs');const link=(await this.store.pool.query('SELECT secret_key FROM personal_credentials WHERE asset_id=$1 AND version=$2',[client.asset_id,client.version])).rows[0];requireCondition(link,'SOURCE_LOGIN_EXPIRED','OAuth client credential is unavailable');clientReference={key:link.secret_key,binding:this.assets.binding(client)};}
    return {profile,grantType:meta.grantType,clientReference};
  }
  async materialize(ctx:AuthContext,row:any,link:any,value:string){
    const authorized=await this.credentialProfile(ctx,row);if(!authorized)return value;const client=authorized.clientReference?JSON.parse(await this.assets.vault.get(authorized.clientReference.key,authorized.clientReference.binding)):undefined;
    requireCondition(!client?.client_id||client.client_id===authorized.profile.clientId,'SOURCE_LOGIN_EXPIRED','OAuth client id differs from its profile');return new OAuthToken(this.assets.vault,{key:link.secret_key,binding:this.assets.binding(row)},authorized.profile,authorized.grantType,client?.client_secret).access();
  }
  async start(ctx:AuthContext,value:unknown,type:'device_authorization'|'client_credentials'){
    const input=OAuthGrantInput.parse(value),parent=await this.owner(ctx,input),profile=await this.profile(input.profileRef),client=await this.secret(ctx,parent.asset_id,input.clientCredentialId);requireCondition(!client?.client_id||client.client_id===profile.clientId,'SOURCE_LOGIN_EXPIRED','Private OAuth client belongs to a different configured client');
    if(type==='device_authorization')requireCondition(profile.deviceAuthorizationEndpoint,'INVALID_PAYLOAD','OAuth issuer has no configured device authorization endpoint');else requireCondition(profile.clientAuthentication!=='none'&&client,'INVALID_PAYLOAD','Client credentials grant needs a confidential client reference');
    const hash=canonicalHash([input,type]),id=newId('ofl'),key=await this.assets.vault.put('{}',JSON.stringify(['oauth-flow',ctx.tenantId,parent.scope_id,ctx.principalId,id]));
    const row=await this.store.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalHash([ctx.tenantId,parent.scope_id,ctx.principalId,input.idempotencyKey])]);const prior=(await tx.query('SELECT * FROM oauth_flows WHERE tenant_id=$1 AND scope_id=$2 AND owner_id=$3 AND idempotency_key=$4',[ctx.tenantId,parent.scope_id,ctx.principalId,input.idempotencyKey])).rows[0];if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_MISMATCH','OAuth grant input differs from its idempotency key');return prior;}return (await tx.query(`INSERT INTO oauth_flows(flow_id,tenant_id,scope_id,owner_id,connector_asset_id,connector_version,profile_ref,profile_digest,grant_type,request_hash,idempotency_key,secret_key,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[id,ctx.tenantId,parent.scope_id,ctx.principalId,parent.asset_id,parent.version,input.profileRef,canonicalHash(profile),type,hash,input.idempotencyKey,key,JSON.stringify(input.clientCredentialId?{clientCredentialId:input.clientCredentialId}:{})])).rows[0];});
    if(row.flow_id!==id){await this.assets.vault.remove(key);return this.view(row);}
    return this.assets.vault.withLock(key,async()=>{
      const response=await oauthRequest(profile,type==='device_authorization'?profile.deviceAuthorizationEndpoint!:profile.tokenEndpoint,type==='device_authorization'?{scope:profile.scope}:{grant_type:'client_credentials',scope:profile.scope},client?.client_secret);
      requireCondition(response.status===200,'SOURCE_UNREACHABLE','OAuth issuer did not accept the grant request');
      if(type==='client_credentials'){await this.assets.vault.replace(key,JSON.stringify({receipt:response.body}),this.binding(row));return this.complete(ctx,row,profile,response.body);}
      let result:any;try{result=z.object({device_code:z.string().min(1),user_code:z.string().min(1).max(500),verification_uri:z.string().url(),expires_in:z.number().int().positive(),interval:z.number().int().positive().default(5)}).parse(response.body);const uri=new URL(result.verification_uri);if(uri.username||uri.password||uri.protocol!=='https:'&&!(uri.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(uri.hostname)))throw new Error();}catch{throw new ApiError('SOURCE_UNREACHABLE','OAuth issuer did not return a valid device authorization receipt');}
      await this.assets.vault.replace(key,JSON.stringify({device_code:result.device_code}),this.binding(row));const pending=(await this.store.pool.query("UPDATE oauth_flows SET state='pending',metadata=metadata || $2::jsonb,interval_seconds=$3::integer,expires_at=clock_timestamp()+($4::double precision*interval '1 second'),next_poll_at=clock_timestamp()+($3::double precision*interval '1 second') WHERE flow_id=$1 RETURNING *",[id,JSON.stringify({userCode:result.user_code,verificationUri:result.verification_uri}),result.interval,result.expires_in])).rows[0];await this.auth.audit(ctx,'credentials.oauth-device-started',{flowId:id,connectorAssetId:parent.asset_id},parent.scope_id);return this.view(pending);
    });
  }
  async poll(ctx:AuthContext,id:string){
    const row=(await this.store.pool.query('SELECT * FROM oauth_flows WHERE flow_id=$1 AND tenant_id=$2 AND owner_id=$3',[id,ctx.tenantId,ctx.principalId])).rows[0];requireCondition(row,'SOURCE_FORBIDDEN','OAuth flow is not available to this identity');await this.owner(ctx,{connectorAssetId:row.connector_asset_id,connectorVersion:row.connector_version,profileRef:row.profile_ref});const profile=await this.profile(row.profile_ref);requireCondition(canonicalHash(profile)===row.profile_digest,'APPROVAL_STALE','OAuth issuer profile changed');
    return this.assets.vault.withLock(row.secret_key,async()=>{
      const current=(await this.store.pool.query('SELECT * FROM oauth_flows WHERE flow_id=$1',[id])).rows[0];if(['authorized','denied','expired'].includes(current.state))return this.view(current);
      const privateState=JSON.parse(await this.assets.vault.get(current.secret_key,this.binding(current)));if(privateState.receipt)return this.complete(ctx,current,profile,privateState.receipt);
      if(current.state!=='pending')throw new ApiError('SOURCE_UNREACHABLE','OAuth grant outcome is unknown; start a new grant explicitly');
      if(current.expires_at.getTime()<=Date.now()){current.state='expired';await this.store.pool.query("UPDATE oauth_flows SET state='expired' WHERE flow_id=$1",[id]);return this.view(current);}if(current.next_poll_at.getTime()>Date.now())return this.view(current);
      const client=await this.secret(ctx,current.connector_asset_id,current.metadata.clientCredentialId);await this.store.pool.query("UPDATE oauth_flows SET state='exchanging' WHERE flow_id=$1",[id]);
      const response=await oauthRequest(profile,profile.tokenEndpoint,{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:privateState.device_code},client?.client_secret);
      if(response.body?.error==='authorization_pending'||response.body?.error==='slow_down'){const interval=current.interval_seconds+(response.body.error==='slow_down'?5:0),pending=(await this.store.pool.query("UPDATE oauth_flows SET state='pending',interval_seconds=$2::integer,next_poll_at=clock_timestamp()+($2::double precision*interval '1 second') WHERE flow_id=$1 RETURNING *",[id,interval])).rows[0];return this.view(pending);}
      if(['access_denied','expired_token'].includes(response.body?.error)){const state=response.body.error==='access_denied'?'denied':'expired',done=(await this.store.pool.query('UPDATE oauth_flows SET state=$2 WHERE flow_id=$1 RETURNING *',[id,state])).rows[0];return this.view(done);}
      requireCondition(response.status===200,'SOURCE_UNREACHABLE','OAuth token exchange did not return a token receipt');tokenBundle(response.body,profile);await this.assets.vault.replace(current.secret_key,JSON.stringify({receipt:response.body}),this.binding(current));return this.complete(ctx,current,profile,response.body);
    });
  }
}
