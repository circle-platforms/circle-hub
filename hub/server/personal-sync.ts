// Dedicated HTTP transport. Model tools and console cookies cannot call this API.
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PERSONAL_SYNC_HTTP_ROUTES,PERSONAL_SYNC_CAPABILITY_ROUTES,PersonalSyncError,personalSyncErrorStatus,personalSyncErrorDetail} from '../../contracts/src/sync.ts';
import {PROTOCOL_CODES,type ProtocolCode} from '../../contracts/generated/protocol.ts';
import {ActionKindSchema,SyncModeSchema} from '../../contracts/generated/vocabulary.ts';
import {RecordsError,parseStrictJson,sha256Hex,type Principal} from '../records/api.ts';
import {KnowledgeError} from '../knowledge/api.ts';
import type {ServerDeps} from './api.ts';
import {readBody,mediaTypeOf,setCommonHeaders,originAllowed,type BodyBudget} from './http.ts';
// The frozen v1 table plus the capability routes advertised in the discovery document (share-single-item).
const routes={...PERSONAL_SYNC_HTTP_ROUTES,...PERSONAL_SYNC_CAPABILITY_ROUTES};
type Route=keyof typeof routes;
/** Index of the sync audit by request id: entries a commit projects name that request as their session. */
export const SYNC_AUDIT_REQUEST_KEY='personal.sync.http.request';
export const personalSyncTarget=(path:string)=>path==='/api/sync'||path.startsWith('/api/sync/');
function target(path:string):{route:Route;id?:string}|null{
 for(const [key,definition]of Object.entries(routes)){
  const pattern='^'+definition.path.replace('{id}','([A-Za-z0-9_-]{1,128})')+'$';const match=new RegExp(pattern).exec(path);if(match)return {route:key as Route,...(match[1]?{id:match[1]}:{})};
 }return null;
}
/** One limiter for both listeners and every token/device of an account; bounded inactive state. */
export class SyncAdmission{
 readonly #accounts=new Map<string,{start:number;count:number;writes:number}>();
 enter(owner:string,write:boolean,now:number,limit:number):(()=>void)|null{
  for(const [id,row]of this.#accounts)if(now-row.start>=60000&&!row.writes)this.#accounts.delete(id);
  let row=this.#accounts.get(owner);if(!row){if(this.#accounts.size>=10000)return null;row={start:now,count:0,writes:0};this.#accounts.set(owner,row);}
  if(now-row.start>=60000){row.start=now;row.count=0;}
  if(++row.count>limit||write&&row.writes>=2)return null;if(write)row.writes++;
  let released=false;return ()=>{if(!released){released=true;if(write)row!.writes--;}};
 }
}
export interface SyncHttpOptions{deps:ServerDeps;budget:BodyBudget;admission:SyncAdmission;origins:ReadonlySet<string>;log:(line:string)=>void;
 /** The origin this request reached the Hub on (the OAuth issuer); names the console page that confirms a purge. */
 issuer:(request:IncomingMessage)=>string}
/** The console page where the owner confirms a purge a client asked for. */
export const PURGE_CONFIRMATION_PAGE='/console/knowledge?scope=personal&sync=settings';
export async function handlePersonalSync(request:IncomingMessage,response:ServerResponse,url:URL,options:SyncHttpOptions):Promise<void>{
 const {deps}=options,started=(deps.now?.()??new Date()).toISOString(),requestId=randomUUID(),selected=target(url.pathname),hold=options.budget.hold();
 let principal:Principal|undefined,identity:{principal:Principal;token_id:string;client_id:string|null}|null=null,release:(()=>void)|undefined;
 let bytes=0,device:string|null=null,epoch:string|null=null,operation:string|null=null,before:string|null=null,after:string|null=null;
 let counts={accepted:0,existing:0,downloaded:0,bytes:0},begun=false;
 const now=()=>deps.now?.()??new Date();
 const audit=async(phase:'started'|'finished',status:number|null,code:ProtocolCode|null)=>{
  if(!principal||!identity)return;
  await deps.records.store.put({kind:'action',schema:'personal-sync-http-audit@1',provenance:'observed',body:{kind:ActionKindSchema.enum.validate,by:principal.id,request:requestId,phase,route:selected?routes[selected.route].path:'/api/sync',method:request.method==='GET'?'GET':request.method==='POST'?'POST':'OTHER',token:identity.token_id,authenticated_client:identity.client_id,declared_client:device,epoch,operation:operation?sha256Hex(operation):null,started_at:started,at:now().toISOString(),status,code,wire_bytes:bytes,previous_state:before,state:after,counts},index:[{key:'personal.sync.http.by',value:principal.id},{key:SYNC_AUDIT_REQUEST_KEY,value:requestId}]});
 };
 const send=async(status:number,value:unknown,headers:Record<string,string>={},auditCode?:ProtocolCode|null)=>{
  let text=JSON.stringify(value),size=Buffer.byteLength(text);
  if(size>deps.config.limits.maxRequestBytes){status=413;auditCode='SYNC_BATCH_LIMIT';text=JSON.stringify(PersonalSyncError.parse({code:auditCode,detail:personalSyncErrorDetail(auditCode)}));size=Buffer.byteLength(text);}
  if(status<400&&!hold.take(size)){status=503;auditCode='SOURCE_RETRYABLE';text=JSON.stringify(PersonalSyncError.parse({code:auditCode,detail:personalSyncErrorDetail(auditCode)}));headers['retry-after']='1';}
  if(begun&&auditCode!==undefined)await audit('finished',status,auditCode);
  if(response.destroyed)return;
  setCommonHeaders(response);response.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':String(Buffer.byteLength(text)),...headers});
  await new Promise<void>(resolve=>{response.once('close',resolve);response.end(text,()=>{response.off('close',resolve);resolve();});});
 };
 const error=async(status:number,code:ProtocolCode,headers:Record<string,string>={},state?:unknown,extra:{confirmation?:{url:string;expires_at:string}}={})=>{await send(status,PersonalSyncError.parse({code,...(state?{state}:{}),...(status===429?{retry_after_seconds:60}:{}),detail:personalSyncErrorDetail(code),...extra}),headers,code);};
 try{
  if(!originAllowed(request,options.origins)){request.resume();await send(403,{code:'SOURCE_UNAVAILABLE'});return;}
  const authenticate=deps.records.principals.authenticateAccessToken;
  identity=authenticate?await authenticate.call(deps.records.principals,request.headers.authorization):null;
  if(!identity){request.resume();await send(401,{code:'SOURCE_UNAVAILABLE'},{'www-authenticate':'Bearer'});return;}principal=identity.principal;
  // Count every authenticated attempt before any append, including unknown routes and wrong methods.
  const write=!!selected&&request.method===routes[selected.route].method&&request.method==='POST'&&selected.route!=='download'&&selected.route!=='missing'&&selected.route!=='modeCheck';
  const entered=options.admission.enter(principal.id,write,now().getTime(),deps.config.limits.syncRequestsPerMinute);if(!entered){request.resume();await error(429,'SYNC_RATE_LIMITED',{'retry-after':'60'});return;}release=entered;
  if(!selected){request.resume();await error(404,'SOURCE_UNAVAILABLE');return;}
  const {route,id}=selected,definition=routes[route],sync=deps.knowledge.personalSync,api=deps.records.personalSync;
  if(request.method!==definition.method){request.resume();await error(405,'SYNC_OBJECT_INVALID',{allow:definition.method});return;}
  await audit('started',null,null);begun=true;
  if(!sync||!api){request.resume();await error(503,'SOURCE_RETRYABLE');return;}
  const current=await api.state(principal);before=current.state_version;
  // Session ownership is checked before touching a potentially large request body.
  if(id&&definition.path.includes('/sessions/'))device=await api.sessionClient(principal,id,current.epoch);
  let body:Record<string,unknown>={};
  if(request.method==='POST'){
   if(mediaTypeOf(request)!=='application/json'){request.resume();await error(415,'SYNC_OBJECT_INVALID');return;}
   if(request.headers['content-encoding']&&request.headers['content-encoding']!=='identity'){request.resume();await error(415,'SYNC_OBJECT_INVALID');return;}
   const read=await readBody(request,deps.config.limits.maxRequestBytes,hold);if(!read.ok){if(read.reason==='aborted'){await audit('finished',499,'SOURCE_RETRYABLE');return;}await error(read.reason==='busy'?503:413,read.reason==='busy'?'SOURCE_RETRYABLE':'SYNC_BATCH_LIMIT',{'connection':'close',...(read.reason==='busy'?{'retry-after':'1'}:{})});return;}bytes=read.bytes.length;
   try{const value=parseStrictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read.bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();body=value as Record<string,unknown>;}catch{await error(422,'SYNC_OBJECT_INVALID');return;}
  }
  const renewed=await authenticate!.call(deps.records.principals,request.headers.authorization);if(!renewed||renewed.token_id!==identity.token_id){await error(401,'SOURCE_UNAVAILABLE',{'www-authenticate':'Bearer'});return;}
  const query=(allowed:readonly string[])=>{const out:Record<string,string>={};for(const [key,value]of url.searchParams){if(!allowed.includes(key)||key in out)throw new RecordsError(PROTOCOL_CODES.SYNC_OBJECT_INVALID.when,{code:'SYNC_OBJECT_INVALID'});out[key]=value;}return out;};
  let result:unknown,modeReceipt=false;
  if(request.method==='POST'&&url.search)throw new RecordsError(PROTOCOL_CODES.SYNC_OBJECT_INVALID.when,{code:'SYNC_OBJECT_INVALID'});
  if(typeof body.epoch==='string'&&z.uuid().safeParse(body.epoch).success)epoch=body.epoch;
  if(typeof body.operation_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(body.operation_id))operation=body.operation_id;
  switch(route){
   case 'state':query([]);result=await sync.state(principal);break;
   case 'client':result=await api.registerClient(principal,body);device=(result as {client_id:string}).client_id;break;
   case 'session':result=await sync.openSession(principal,body);device=typeof body.client_id==='string'?body.client_id:null;break;
   case 'inventory':{const q=query(['epoch','cursor']);epoch=z.uuid().parse(q.epoch);result=await api.inventory(principal,id!,epoch,q.cursor);break;}
   case 'missing':result=await api.missing(principal,id!,body);break;
   case 'upload':result=await api.upload(principal,id!,body);break;
   case 'download':result=await api.download(principal,id!,body);counts.downloaded=(result as {objects:unknown[]}).objects.length;break;
   case 'commit':result=await sync.commit(principal,id!,body,requestId);break;
   case 'abort':result=await api.abort(principal,id!,body);break;
   case 'modeCheck':result=await sync.modeCheck(principal,body);break;
   case 'share':result=await sync.shareItem(principal,body,requestId);break;
   case 'mode':{
    // A Bearer token alone never purges: the owner confirms the recorded request in the console, then the client's
    // identical retry replays the receipt (capability purge-confirmation).
    const changed=await sync.changeMode(principal,body,{request:requestId,token:identity.token_id,client:identity.client_id});
    if('confirmation'in changed){const issuer=options.issuer(request);await error(personalSyncErrorStatus('SYNC_PURGE_CONFIRMATION_REQUIRED'),'SYNC_PURGE_CONFIRMATION_REQUIRED',{},undefined,{confirmation:{url:issuer+PURGE_CONFIRMATION_PAGE,expires_at:changed.confirmation.expires_at}});return;}
    result=changed;break;}
   case 'operation':{const q=query(['epoch','cursor']);epoch=z.uuid().parse(q.epoch);result=await api.modeOperation(principal,epoch,id!);modeReceipt=!!result;if(!result&&epoch===current.epoch&&current.mode===SyncModeSchema.enum.hub)result=await api.result(principal,epoch,id!,q.cursor)??await api.operation(principal,epoch,id!);if(!result)throw new RecordsError(PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,{code:'SOURCE_UNAVAILABLE'});break;}
  }
  const receipt=(result as {receipt?:{counts:typeof counts;state_version:string;previous_state:string|null};counts?:typeof counts}),state=(result as {state?:{state_version:string};state_version?:string});
  if(receipt.receipt){counts=receipt.receipt.counts;after=receipt.receipt.state_version;}else if(receipt.counts)counts=receipt.counts;
  after??=state.state?.state_version??state.state_version??null;
  if(route==='download')counts.bytes=(result as {objects:Array<{bytes_base64:string}>}).objects.reduce((n,o)=>n+Buffer.from(o.bytes_base64,'base64').length,0);
  // Refuse delivery of private batches after purge or token revocation, even when the work completed meanwhile.
  const finalIdentity=await authenticate!.call(deps.records.principals,request.headers.authorization);if(!finalIdentity||finalIdentity.token_id!==identity.token_id){await error(401,'SOURCE_UNAVAILABLE',{'www-authenticate':'Bearer'});return;}
  if(epoch&&route!=='mode'&&!modeReceipt){const latest=await api.state(principal);if(latest.epoch!==epoch)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});if(route!=='share'&&latest.mode!==SyncModeSchema.enum.hub)throw new RecordsError(PROTOCOL_CODES.SYNC_MODE_LOCAL.when,{code:'SYNC_MODE_LOCAL'});}
  await send(200,result,{},null);
 }catch(cause){
  const code=cause instanceof z.ZodError?'SYNC_OBJECT_INVALID':(cause instanceof RecordsError||cause instanceof KnowledgeError)&&cause.code?cause.code:'SOURCE_RETRYABLE';
  const status=personalSyncErrorStatus(code);
  try{await error(status,code,code==='SOURCE_RETRYABLE'?{'retry-after':'1'}:{},cause instanceof RecordsError?cause.detail.state:undefined);}catch{options.log('同步请求审计未完成');if(!response.headersSent)await send(503,{code:'SOURCE_RETRYABLE'},{'retry-after':'1'});else response.destroy();}
 }finally{hold.release();release?.();}
}
