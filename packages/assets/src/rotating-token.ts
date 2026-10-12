import {z} from 'zod';
import {ApiError} from '../../contracts/src/index.ts';
import {privateHttp,type Trust} from '../../connectors/src/private-http.ts';
import type {PrivateVault} from './vault.ts';

const Bundle=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1),expires_at:z.number().finite(),scope:z.string().default(''),server:z.string().optional(),rotationPending:z.boolean().optional(),revoked:z.boolean().optional()});
export class RotatingToken {
  vault:PrivateVault;reference:{key:string;binding:string};profile:{issuer:string}&Trust;
  constructor(vault:PrivateVault,reference:{key:string;binding:string},profile:{issuer:string}&Trust){this.vault=vault;this.reference=reference;this.profile=profile;}
  async access(force=false):Promise<string>{return this.vault.withLock(this.reference.key,async()=>{
    let bundle:z.infer<typeof Bundle>;try{bundle=Bundle.parse(JSON.parse(await this.vault.get(this.reference.key,this.reference.binding)));}catch{throw new ApiError('SOURCE_LOGIN_EXPIRED','Register a personal OAuth token bundle including its refresh token');}
    if(bundle.rotationPending||bundle.revoked)throw new ApiError('SOURCE_LOGIN_EXPIRED','Register a new personal source session',{reason:bundle.rotationPending?'refresh_outcome_unknown':'refresh_revoked'});
    if(bundle.server&&new URL(bundle.server).origin!==new URL(this.profile.issuer).origin)throw new ApiError('SOURCE_LOGIN_EXPIRED','Source session belongs to another issuer');
    if(!force&&bundle.expires_at*1000>Date.now()+60000)return bundle.access_token;
    await this.vault.replace(this.reference.key,JSON.stringify({...bundle,rotationPending:true}),this.reference.binding);
    const issuer=new URL('/token',this.profile.issuer),body=new URLSearchParams({grant_type:'refresh_token',refresh_token:bundle.refresh_token}).toString();
    const response=await privateHttp(issuer,{...this.profile,body,headers:{'content-type':'application/x-www-form-urlencoded'}});
    if(response.status>=500){await this.vault.replace(this.reference.key,JSON.stringify(bundle),this.reference.binding);throw new ApiError('SOURCE_UNREACHABLE','Source token issuer is unavailable',{httpStatus:response.status});}
    if(response.status===400&&response.body?.error==='invalid_grant'){await this.vault.replace(this.reference.key,JSON.stringify({...bundle,revoked:true}),this.reference.binding);throw new ApiError('SOURCE_LOGIN_EXPIRED','Personal source session was revoked or expired');}
    let issued:any;try{issued=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1),expires_in:z.number().int().positive(),scope:z.string().optional()}).parse(response.body);if(response.status!==200)throw new Error();}catch{throw new ApiError('SOURCE_UNREACHABLE','Token rotation did not return a complete receipt');}
    const next={access_token:issued.access_token,refresh_token:issued.refresh_token,expires_at:Date.now()/1000+issued.expires_in,scope:issued.scope??bundle.scope,server:this.profile.issuer};await this.vault.replace(this.reference.key,JSON.stringify(next),this.reference.binding);return next.access_token;
  });}
}
