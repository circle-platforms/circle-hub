import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {ApiError,requireCondition,sha256} from '../../contracts/src/index.ts';

export interface Trust {caFile?:string;caSha256?:string}
export async function resolveTrust(trust:Trust):Promise<{ca?:Buffer;caSha256?:string}>{
  if(!trust.caFile){requireCondition(!trust.caSha256,'INVALID_PAYLOAD','A pinned CA needs a runtime CA file');return {};}
  try{const ca=await readFile(trust.caFile),digest=sha256(new X509Certificate(ca).raw);requireCondition(!trust.caSha256||digest===trust.caSha256.toLowerCase().replaceAll(':',''),'TARGET_IDENTITY_MISMATCH','Runtime CA fingerprint changed');return {ca,caSha256:digest};}
  catch(error){if(error instanceof ApiError)throw error;throw new ApiError('SOURCE_UNREACHABLE','Runtime CA is unavailable');}
}
// Runtime trust is per connection. Neither redirects nor global TLS bypasses are used.
export async function privateHttp(url:URL,options:{headers?:Record<string,string>;body:string;timeoutMs?:number;signal?:AbortSignal}&Trust):Promise<{status:number;body:any}>{
  requireCondition(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&(url.protocol==='https:'||['127.0.0.1','[::1]','localhost'].includes(url.hostname)),'INVALID_PAYLOAD','Remote private HTTP requires TLS');
  const {ca}=await resolveTrust(options);
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',headers:{...options.headers,'content-length':Buffer.byteLength(options.body)},...(ca?{ca}:{}),rejectUnauthorized:true,signal:options.signal},response=>{
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024){request.destroy();reject(new ApiError('RESULT_TOO_LARGE','Private source exceeds the response byte limit'));}else chunks.push(Buffer.from(chunk));});
      response.on('error',()=>reject(new ApiError('SOURCE_UNREACHABLE','Private source response was interrupted')));
      response.on('end',()=>{let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{body=null;}resolve({status:response.statusCode??0,body});});
    });
    const timer=setTimeout(()=>request.destroy(),options.timeoutMs??30000);request.once('close',()=>clearTimeout(timer));
    request.once('error',()=>reject(new ApiError('SOURCE_UNREACHABLE','Private source transport is unavailable')));request.end(options.body);
  });
}
