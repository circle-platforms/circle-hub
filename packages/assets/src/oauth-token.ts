import {z} from 'zod';
import {ApiError} from '../../contracts/src/index.ts';
import {oauthRequest,tokenBundle,type OAuthProfile} from './oauth.ts';
import type {PrivateVault} from './vault.ts';

const bundle=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1).optional(),expires_at:z.number().finite().nullable(),scope:z.string().default(''),server:z.string().optional(),rotationPending:z.boolean().optional(),revoked:z.boolean().optional()}).passthrough();
export class OAuthToken{
  vault:PrivateVault;reference:{key:string;binding:string};profile:OAuthProfile;grantType:string;clientSecret?:string;
  constructor(vault:PrivateVault,reference:{key:string;binding:string},profile:OAuthProfile,grantType:string,clientSecret?:string){this.vault=vault;this.reference=reference;this.profile=profile;this.grantType=grantType;this.clientSecret=clientSecret;}
  async access(force=false):Promise<string>{return this.vault.withLock(this.reference.key,async()=>{
    let current:z.infer<typeof bundle>;try{current=bundle.parse(JSON.parse(await this.vault.get(this.reference.key,this.reference.binding)));}catch{throw new ApiError('SOURCE_LOGIN_EXPIRED','Register a new OAuth credential session');}
    if(current.revoked||current.rotationPending)throw new ApiError('SOURCE_LOGIN_EXPIRED','OAuth credential needs a new authorized session',{reason:current.rotationPending?'refresh_outcome_unknown':'refresh_revoked'});
    if(current.server&&new URL(current.server).origin!==new URL(this.profile.issuer).origin)throw new ApiError('SOURCE_LOGIN_EXPIRED','OAuth credential belongs to another issuer');
    if(!force&&(current.expires_at===null||current.expires_at*1000>Date.now()+60000))return current.access_token;
    const fields:Record<string,string>|null=current.refresh_token?{grant_type:'refresh_token',refresh_token:current.refresh_token}:this.grantType==='client_credentials'?{grant_type:'client_credentials',scope:current.scope}:null;
    if(!fields)throw new ApiError('SOURCE_LOGIN_EXPIRED','OAuth credential cannot renew without a supported grant');
    await this.vault.replace(this.reference.key,JSON.stringify({...current,rotationPending:true}),this.reference.binding);
    const response=await oauthRequest(this.profile,this.profile.tokenEndpoint,fields,this.clientSecret);
    if(response.status>=500){await this.vault.replace(this.reference.key,JSON.stringify(current),this.reference.binding);throw new ApiError('SOURCE_UNREACHABLE','OAuth token issuer is unavailable');}
    if(['invalid_grant','invalid_client'].includes(response.body?.error)){await this.vault.replace(this.reference.key,JSON.stringify({...current,revoked:true}),this.reference.binding);throw new ApiError('SOURCE_LOGIN_EXPIRED','OAuth grant or client credential was rejected');}
    if(response.status!==200)throw new ApiError('SOURCE_UNREACHABLE','OAuth renewal did not return a token receipt');const next=tokenBundle(response.body,this.profile,current);await this.vault.replace(this.reference.key,JSON.stringify(next),this.reference.binding);return next.access_token;
  });}
}
