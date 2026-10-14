import {z} from 'zod';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';
import {privateHttp} from './private-http.ts';

const HostCommandPolicy=z.object({allowedCommands:z.array(z.string().min(1).max(16384)).max(256).optional(),maxCommandBytes:z.number().int().min(1).max(16384).optional(),maxTimeoutSeconds:z.number().int().min(1).max(3600).optional(),allowMultiline:z.boolean().optional()}).strict();
export const GatewayProfile=z.object({endpoint:z.string().url(),issuer:z.string().url().optional(),caFile:z.string().optional(),caSha256:z.string().regex(/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/).optional(),issuerCaFile:z.string().optional(),issuerCaSha256:z.string().optional(),allowedTestHosts:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(100).default([]),hostCommandPolicies:z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),HostCommandPolicy).optional(),timeoutMs:z.number().int().min(100).max(120000).default(60000),pollMs:z.number().int().min(25).max(30000).default(2000)}).strict();
export type GatewayProfile=z.infer<typeof GatewayProfile>;
export class McpGateway {
  profile:GatewayProfile;token:(force?:boolean)=>Promise<string>;seq=0;
  constructor(profile:z.input<typeof GatewayProfile>,token:(force?:boolean)=>Promise<string>){this.profile=GatewayProfile.parse(profile);this.token=token;}
  async rpc(method:string,params:any,signal?:AbortSignal):Promise<any>{
    const id=++this.seq,token=await this.token(),response=await privateHttp(new URL(this.profile.endpoint),{...this.profile,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},signal});
    if(response.status===401)throw new ApiError('SOURCE_LOGIN_EXPIRED','Gateway rejected the resource session',{httpStatus:401});
    if(response.status===403)throw new ApiError('SOURCE_FORBIDDEN','Gateway does not authorize this operation');
    if(response.status!==200)throw new ApiError('SOURCE_UNREACHABLE','Gateway or its token verification service is unavailable',{httpStatus:response.status});
    requireCondition(response.body?.jsonrpc==='2.0'&&response.body.id===id&&response.body.result&&!response.body.error,'SOURCE_UNREACHABLE','Gateway JSON-RPC receipt is malformed');
    requireCondition(!JSON.stringify(response.body).includes(token),'SOURCE_UNREACHABLE','Gateway returned private authorization material');return response.body.result;
  }
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<any>{
    const result=await this.rpc('tools/call',{name,arguments:args},signal);let outcome=result.structuredContent;
    if(!outcome){try{outcome=JSON.parse(result.content?.find((item:any)=>item.type==='text')?.text);}catch{throw new ApiError('SOURCE_UNREACHABLE','Gateway tool receipt is malformed');}}
    if(result.isError||outcome?.ok===false){const reason=typeof outcome?.reason==='string'?outcome.reason:typeof outcome?.error==='string'?outcome.error:'Gateway refused the requested operation';throw new ApiError('GATEWAY_REFUSED',reason,{tool:name,gatewayRefusal:outcome});}
    requireCondition(outcome?.ok===true,'SOURCE_UNREACHABLE','Gateway did not confirm its tool receipt');return outcome;
  }
}
