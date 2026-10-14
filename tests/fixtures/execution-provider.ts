import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {TestContext} from 'node:test';

export async function executionProvider(t:TestContext){
 const state={secret:'synthetic-provider-secret-'.repeat(3),calls:[] as {name:string;args:any;meta:any}[],submissions:0,prepares:0,releases:0,heartbeats:0,lost:false,hold:false,holdPrepare:false,holdSubmit:false,failPrepare:false,failResults:false,dropSubmit:false,refuse:false,refuseStatus:false,refuseHeartbeat:false,leaseTtl:120,refusalDispatch:false,refuseRelease:false,forgedTerminal:false,allowSubmitExtras:false,resultLog:'',remoteId:'remote_synthetic_1',requestHash:'',inputSha256:'',byteHashes:{} as Record<string,string>,payloadBytes:0,payloadSha256:''};
 const receipt=(withResults=false)=>({ok:true,task_id:state.remoteId,request_hash:state.requestHash,input_sha256:state.inputSha256,byte_hashes:state.byteHashes,state:state.hold?'running':'done',...(withResults?{result:{items:[{id:'synthetic-item',verdict:'observed'}],...(state.resultLog?{log:state.resultLog}:{})}}:{})});
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(405);res.end();return;}
  if(req.headers.authorization!==`Bearer ${state.secret}`){res.writeHead(401);res.end();return;}
  let rpc:any;try{const parts=[];for await(const bytes of req)parts.push(bytes);rpc=JSON.parse(Buffer.concat(parts).toString());}catch{res.writeHead(400);res.end();return;}
  if(rpc.method==='tools/list'){const tools=[...providerTools(),...providerTools('alternate').filter(tool=>!tool.name.startsWith('lease_'))].map(tool=>state.allowSubmitExtras&&tool.name.endsWith('_submit')?{...tool,inputSchema:{...tool.inputSchema,additionalProperties:true}}:tool);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools}}));return;}
  const wireName=rpc.params?.name,name=typeof wireName==='string'?wireName.replace(/^alternate_/,'meridian_'):wireName,args=rpc.params?.arguments??{},meta=rpc.params?._meta??{};state.calls.push({name:wireName,args,meta});let result:any={ok:true};
  if(name==='lease_acquire')result={ok:true,lease_id:'lease_synthetic',token:1,expires_in_s:state.leaseTtl};
  else if(name==='lease_heartbeat'){state.heartbeats++;result=state.refuseHeartbeat?{ok:false,stage:'lease',dispatched:false,reason:'Synthetic heartbeat refusal'}:{ok:true,expires_in_s:state.leaseTtl};}
  else if(name==='lease_release'){state.releases++;result=state.refuseRelease?{ok:false,reason:'Synthetic release refused'}:{ok:true};}
  else if(name==='meridian_prepare'){state.prepares++;if(state.failPrepare){req.socket.destroy();return;}while(state.holdPrepare&&!res.destroyed)await new Promise(resolve=>setTimeout(resolve,20));if(res.destroyed)return;result={ok:true,ready:true};}
  else if(name==='meridian_submit'){
   if(state.refuse)result={ok:false,stage:'validation',dispatched:state.refusalDispatch,...(state.refusalDispatch?{task_id:state.remoteId}:{}),code:'GATEWAY_REFUSED',reason:'Synthetic pre-dispatch refusal'};
   else{const bytes=Buffer.from(args.payload_b64??'','base64');state.submissions++;state.remoteId=`remote_synthetic_${state.submissions}`;state.payloadBytes=bytes.length;state.payloadSha256=createHash('sha256').update(bytes).digest('hex');state.requestHash=meta['hub/requestHash'];state.inputSha256=meta['hub/inputSha256'];state.byteHashes={payload_b64:state.payloadSha256};if(state.dropSubmit){req.socket.destroy();return;}while(state.holdSubmit&&!res.destroyed)await new Promise(resolve=>setTimeout(resolve,20));if(res.destroyed)return;result={...receipt(),state:'running',dispatched:true};}
  }else if(name==='meridian_status'||name==='meridian_results'){
   if(name==='meridian_status'&&state.refuseStatus){result={ok:false,stage:'validation',dispatched:false,reason:'Synthetic status refusal'};}else if(state.lost||name==='meridian_results'&&state.failResults){req.socket.destroy();return;}else result=receipt(name==='meridian_results');if(state.forgedTerminal)result={...result,request_hash:'f'.repeat(64)};
  }else{res.writeHead(400);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return {endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`,state};
}
export function providerTools(prefix='meridian'){const object=(properties:any={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:false}),string={type:'string'};return [
 {name:'meridian_prepare',effect:'read',inputSchema:object()},
 {name:'meridian_submit',effect:'write',inputSchema:object({label:string,payload_b64:string,lease_id:string,token:{type:'integer'}},['payload_b64'])},
 {name:'meridian_status',effect:'read',inputSchema:object({task_id:string,lease_id:string,token:{type:'integer'}})},
 {name:'meridian_results',effect:'read',inputSchema:object({task_id:string,lease_id:string,token:{type:'integer'}})},
 {name:'lease_acquire',effect:'write',inputSchema:object()},
 {name:'lease_heartbeat',effect:'write',inputSchema:object({lease_id:string,token:{type:'integer'}},['lease_id','token'])},
 {name:'lease_release',effect:'write',inputSchema:object({lease_id:string,token:{type:'integer'}},['lease_id','token'])},
 ].map(tool=>({...tool,name:tool.name.replace(/^meridian_/,prefix+'_'),description:'Synthetic execution provider Tool',minimumRole:'member',approval:false,annotations:{readOnlyHint:tool.effect==='read',destructiveHint:tool.effect==='write'}}));}
