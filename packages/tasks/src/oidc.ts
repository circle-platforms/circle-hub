import {createVerify,randomBytes} from 'node:crypto';
import {ApiError,OidcCallback,requireCondition,sha256,type AuthContext} from '../../contracts/src/index.ts';
import type {Store} from '../../storage/src/index.ts';
import type {Auth} from './auth.ts';
import {z} from 'zod';

const configSchema=z.object({issuer:z.string().url(),clientId:z.string().min(1).max(200),clientSecret:z.string().min(1).max(2048),authorizationUrl:z.string().url(),tokenUrl:z.string().url(),redirectUri:z.string().url(),publicKeyPem:z.string().min(1).max(20000)}).strict();
export type OidcConfig=z.infer<typeof configSchema>;

function loopback(value:string,label:string):URL{
  let url:URL;
  try{url=new URL(value);}catch{throw new ApiError('INVALID_PAYLOAD',`${label} must be a loopback URL`);}
  requireCondition(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password,'INVALID_PAYLOAD',`${label} must be loopback HTTP or HTTPS`);
  return url;
}

export function readOidcConfig(raw:string|undefined):OidcConfig|undefined{
  if(!raw)return;
  const config=configSchema.parse(JSON.parse(raw));
  loopback(config.authorizationUrl,'OIDC authorization URL');
  loopback(config.tokenUrl,'OIDC token URL');
  loopback(config.redirectUri,'OIDC redirect URI');
  loopback(config.issuer,'OIDC issuer');
  return config;
}

function payloadOf(token:string,pem:string):any{
  const parts=token.split('.');
  requireCondition(parts.length===3,'UNAUTHENTICATED','OIDC login could not be verified');
  const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
  requireCondition(header.alg==='RS256','UNAUTHENTICATED','OIDC login could not be verified');
  const verify=createVerify('RSA-SHA256');
  verify.update(`${parts[0]}.${parts[1]}`);
  requireCondition(verify.verify(pem,Buffer.from(parts[2],'base64url')),'UNAUTHENTICATED','OIDC login could not be verified');
  return JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
}

export class OidcLogin {
  store:Store;auth:Auth;config?:OidcConfig;
  constructor(store:Store,auth:Auth,raw:string|undefined){this.store=store;this.auth=auth;this.config=readOidcConfig(raw);}
  async start():Promise<{authorizationUrl:string;state:string}>{
    requireCondition(this.config,'TARGET_NOT_FOUND','OIDC is not configured');
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
    await this.store.pool.query('DELETE FROM oidc_transactions WHERE expires_at<=clock_timestamp()');
    await this.store.pool.query('INSERT INTO oidc_transactions(state_hash,nonce,redirect_uri,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'10 minutes\')',[sha256(state),nonce,this.config.redirectUri]);
    const url=new URL(this.config.authorizationUrl);
    url.searchParams.set('response_type','code');
    url.searchParams.set('client_id',this.config.clientId);
    url.searchParams.set('redirect_uri',this.config.redirectUri);
    url.searchParams.set('scope','openid');
    url.searchParams.set('state',state);
    url.searchParams.set('nonce',nonce);
    return {authorizationUrl:url.toString(),state};
  }
  async callback(value:unknown):Promise<{token:string;expiresAt:string;principalId:string}>{
    requireCondition(this.config,'TARGET_NOT_FOUND','OIDC is not configured');
    const input=OidcCallback.parse(value);
    const transaction=await this.store.transaction(async tx=>{
      const row=(await tx.query('DELETE FROM oidc_transactions WHERE state_hash=$1 AND expires_at>clock_timestamp() RETURNING *',[sha256(input.state)])).rows[0];
      requireCondition(row,'UNAUTHENTICATED','OIDC login could not be verified');
      return row;
    });
    const body=new URLSearchParams({grant_type:'authorization_code',code:input.code,redirect_uri:transaction.redirect_uri,client_id:this.config.clientId,client_secret:this.config.clientSecret});
    const tokenUrl=loopback(this.config.tokenUrl,'OIDC token URL');
    let response:Response;
    try{response=await fetch(tokenUrl, {method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body});}
    catch{throw new ApiError('UNAUTHENTICATED','OIDC login could not be verified');}
    if(!response.ok)throw new ApiError('UNAUTHENTICATED','OIDC login could not be verified');
    const tokenBody=await response.json() as {id_token?:string};
    requireCondition(typeof tokenBody.id_token==='string','UNAUTHENTICATED','OIDC login could not be verified');
    let claims:any;
    try{claims=payloadOf(tokenBody.id_token,this.config.publicKeyPem);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError('UNAUTHENTICATED','OIDC login could not be verified');}
    requireCondition(claims.iss===this.config.issuer&&(claims.aud===this.config.clientId||Array.isArray(claims.aud)&&claims.aud.includes(this.config.clientId))&&claims.nonce===transaction.nonce&&typeof claims.exp==='number'&&claims.exp*1000>Date.now()&&typeof claims.sub==='string'&&claims.sub.length>0&&claims.sub.length<=300,'UNAUTHENTICATED','OIDC login could not be verified');
    const bySubject=(await this.store.pool.query("SELECT principal_id FROM policies WHERE oidc_sub=$1 AND kind='user' AND NOT disabled",[claims.sub])).rows;
    const matches=bySubject.length?bySubject:typeof claims.email==='string'?(await this.store.pool.query("SELECT principal_id FROM policies WHERE username=$1 AND kind='user' AND NOT disabled",[claims.email])).rows:[];
    requireCondition(matches.length===1,'UNAUTHENTICATED','OIDC subject is not provisioned');
    const issued=await this.auth.issueForPrincipal(matches[0].principal_id);
    return {...issued,principalId:matches[0].principal_id};
  }
  async session(principalId:string,issued:{token:string;expiresAt:string}){
    const identity={principalId,tenantId:'',kind:'user'} as AuthContext;
    const policy=await this.auth.policy({...identity,principalId});
    return {...issued,tokenType:'Bearer' as const,principalId:policy.principalId,tenantId:policy.tenantId,scopes:policy.scopes,subjectType:'human' as const,roles:policy.roles};
  }
}
