import {createServer,request as httpRequest,type IncomingMessage} from 'node:http';
import {request as httpsRequest,type RequestOptions} from 'node:https';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {ApiError,MAX_SOURCE_BYTES,requireCondition} from '../../contracts/src/index.ts';
import {resolveTrust,type Trust} from '../../connectors/src/private-http.ts';

export interface ModelProxyMetadata {upstreamHost:string;statusCode:number|null;requestBytes:number;responseBytes:number;durationMs:number;requestNumber:number}
export interface ModelProxyOptions extends Trust {allowedUpstreams?:string[];requestBytes?:number;responseBytes?:number;lookup?:RequestOptions['lookup'];onMetadata?:(item:ModelProxyMetadata)=>void|Promise<void>}
// The destination is frozen by the approved runtime profile. Incoming URLs and
// headers cannot choose a host, path, credential or redirect target.
export async function modelProxy(baseUrl:string,key:string,options:ModelProxyOptions={}){
  const base=new URL(baseUrl);requireCondition(options.allowedUpstreams?.some(value=>new URL(value).href===base.href)&&!base.username&&!base.password&&!base.search&&!base.hash&&(base.protocol==='https:'||base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)),'FORBIDDEN_ACTION','Model endpoint must belong to the bound approved runtime profile and use HTTPS outside loopback');
  let trust:Awaited<ReturnType<typeof resolveTrust>>;try{trust=await resolveTrust(options);}catch{throw new ApiError('MODEL_PROXY_UNAVAILABLE','Configured model trust is unavailable');}
  const routes=new Map([['/v1/models',new URL('models',base.href.replace(/\/$/,'')+'/')],['/v1/chat/completions',new URL('chat/completions',base.href.replace(/\/$/,'')+'/')]]);
  const nonce=randomBytes(32).toString('base64url'),active=new Set<AbortController>();let failure:ApiError|undefined,sequence=0,closed=false,closing:Promise<void>|undefined,metadata=Promise.resolve();
  const unavailable=()=>new ApiError('MODEL_PROXY_UNAVAILABLE','The run model proxy is unavailable');
  const rejected=()=>new ApiError('MODEL_UPSTREAM_REJECTED','The configured model upstream rejected or exceeded the bounded request');
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${nonce}`){res.writeHead(401);res.end();return;}
    const destination=routes.get(req.url??'');if(!destination||(req.url==='/v1/models'?req.method!=='GET':req.method!=='POST')){res.writeHead(405);res.end();return;}
    const controller=new AbortController(),started=performance.now(),requestNumber=++sequence;active.add(controller);res.once('close',()=>controller.abort());
    let requestBytes=0,responseBytes=0,statusCode:number|null=null;
    try{
      const chunks:Buffer[]=[];for await(const part of req){requestBytes+=part.length;if(requestBytes>(options.requestBytes??MAX_SOURCE_BYTES)){res.writeHead(413);res.end();failure??=rejected();return;}chunks.push(part);}
      const response=await new Promise<IncomingMessage>((resolve,reject)=>{const request=(destination.protocol==='https:'?httpsRequest:httpRequest)(destination,{method:req.method,signal:controller.signal,rejectUnauthorized:true,...(trust.ca?{ca:trust.ca}:{}),...(options.lookup?{lookup:options.lookup}:{}),headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},resolve);request.setTimeout(120000,()=>request.destroy());request.once('error',reject);request.end(req.method==='POST'?Buffer.concat(chunks):undefined);});
      statusCode=response.statusCode??502;if(statusCode<200||statusCode>=300){failure??=rejected();response.destroy();res.writeHead(502);res.end();return;}
      res.setHeader('content-type',response.headers['content-type']??'application/json');res.setHeader('cache-control','no-store');
      for await(const part of response){responseBytes+=part.length;if(responseBytes>(options.responseBytes??MAX_SOURCE_BYTES)){response.destroy();throw rejected();}if(res.destroyed)break;if(!res.write(part))await once(res,'drain',{signal:controller.signal});}
      if(!res.destroyed)res.end();
    }catch(error){if(!closed&&!controller.signal.aborted)failure??=error instanceof ApiError?error:unavailable();if(!res.destroyed){if(!res.headersSent){res.writeHead(502);res.end();}else res.destroy();}}
    finally{active.delete(controller);const item={upstreamHost:base.hostname,statusCode,requestBytes,responseBytes,durationMs:Math.round(performance.now()-started),requestNumber};metadata=metadata.then(()=>options.onMetadata?.(item)).then(()=>{}).catch(()=>{if(!closed)failure??=unavailable();});}
  });
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch{throw unavailable();}
  return {url:`http://127.0.0.1:${(server.address() as any).port}/v1`,nonce,get failure(){return failure;},flush:()=>metadata,close:()=>closing??=(async()=>{closed=true;for(const controller of active)controller.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await metadata;})()};
}
