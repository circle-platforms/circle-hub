import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,lstat,realpath,rm} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {ApiError,MAX_SOURCE_BYTES,SafeRelativePath,canonicalJson,requireCondition,sha256} from '../../contracts/src/index.ts';

import {isolatedProcess} from './isolation.ts';
import {modelProxy} from './model-proxy.ts';
import {redactBytes} from './redaction.ts';
const execute=promisify(execFile);
export interface CircleRun {
  runtime:{circleBin:string;circleCommit:string;circleVersion:string;model:{kind:'scripted'|'remote';base_url:string;model:string;protocol:string;api_key:string;caFile?:string;caSha256?:string}};
  approvedModel:{endpoint:string;runtimeProfile:Record<string,string>};
  folder:string;manifest:any;files:{path:string;bytes:Buffer;sha256:string}[];inputs:Record<string,unknown>;
  serverUrl:string;serverToken:string;scopeId:string;principalId:string;signal?:AbortSignal;
  event:(event:any)=>Promise<void>;
}
export async function runCircle(input:CircleRun):Promise<any>{
  requireCondition(input.approvedModel?.endpoint===input.runtime.model.base_url&&['assetId','version','sha256','profileSha256'].every(key=>typeof input.approvedModel.runtimeProfile?.[key]==='string'),'FORBIDDEN_ACTION','Model endpoint differs from the approved run binding');
  const proxy=await modelProxy(input.runtime.model.base_url,input.runtime.model.api_key,{allowedUpstreams:[input.approvedModel.endpoint],caFile:input.runtime.model.caFile,caSha256:input.runtime.model.caSha256,onMetadata:metadata=>input.event({type:'model.proxy',runtimeProfile:input.approvedModel.runtimeProfile,...metadata})});
  const close=()=>{void proxy.close();};input.signal?.addEventListener('abort',close,{once:true});
  try{const result=await runIsolatedCircle({...input,runtime:{...input.runtime,model:{...input.runtime.model,base_url:proxy.url,api_key:proxy.nonce}}},input.runtime.model.api_key,close);await proxy.flush();if(proxy.failure)throw proxy.failure;return result;}
  catch(error){await proxy.flush();if(error instanceof ApiError&&error.details.localExitObserved===true)throw error;throw proxy.failure??error;}
  finally{input.signal?.removeEventListener('abort',close);await proxy.close();await rm(join(input.folder,'home'),{recursive:true,force:true});await rm(join(input.folder,'home-user'),{recursive:true,force:true});}
}
async function runIsolatedCircle(input:CircleRun,upstreamModelKey:string,onStopping:()=>void):Promise<any>{
  const {runtime}=input,circleBin=resolve(runtime.circleBin),repo=dirname(dirname(circleBin));
  const home=join(input.folder,'home'),homeUser=join(input.folder,'home-user'),workspace=join(input.folder,'workspace');
  for(const directory of [home,homeUser,workspace])await mkdir(directory,{recursive:true,mode:0o700});
  let version:string,commit:string;
  try{version=(await execute(process.execPath,[circleBin,'--version'],{timeout:5000,env:{PATH:process.env.PATH,HOME:homeUser,CIRCLE_HOME:home,CIRCLE_NO_MODELS_REFRESH:'1'}})).stdout.trim();commit=(await execute('git',['-C',repo,'rev-parse','HEAD'],{timeout:5000})).stdout.trim();}
  catch{throw new ApiError('RUNTIME_VERSION_MISMATCH','Circle executable or Git revision cannot be verified');}
  requireCondition(version===runtime.circleVersion&&commit===runtime.circleCommit,'RUNTIME_VERSION_MISMATCH','Circle version or Git revision differs from the pinned runtime');
  const modelUrl=new URL(runtime.model.base_url);requireCondition(modelUrl.hostname==='127.0.0.1'&&modelUrl.protocol==='http:','FORBIDDEN_ACTION','Sandbox model requests must use the per-run loopback proxy');
  await writeFile(join(home,'settings.json'),JSON.stringify({version:1,initialized:true,auth:{base_url:runtime.model.base_url,model:runtime.model.model,protocol:runtime.model.protocol,api_key_ref:'api_key'},trusted_folders:[workspace],extensions:{'circle-server':{enabled:true}},mcp_servers:[],update_check:false}),{mode:0o600});
  await writeFile(join(home,'credentials.json'),JSON.stringify({api_key:runtime.model.api_key}),{mode:0o600});
  const skillRoot=join(workspace,'.circle','skills',input.manifest.id);
  for(const file of input.files){SafeRelativePath.parse(file.path);requireCondition(sha256(file.bytes)===file.sha256,'SOURCE_HASH_MISMATCH','Skill blob SHA differs');const path=join(skillRoot,file.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,file.bytes,{mode:0o600});}
  await writeFile(join(workspace,'inputs.json'),canonicalJson(input.inputs),{mode:0o600});
  if(Array.isArray(input.inputs.files))for(const file of input.inputs.files as any[]){SafeRelativePath.parse(file.path);requireCondition(!file.path.split('/').some((part:string)=>part.startsWith('.')||part.toLowerCase()==='agents.md')&&file.path!=='inputs.json'&&!input.manifest.outputs.includes(file.path),'INVALID_PAYLOAD','Input files cannot replace runtime control files or declared outputs');requireCondition(typeof file.base64==='string','INVALID_PAYLOAD','Input files require base64 bytes');const bytes=Buffer.from(file.base64,'base64');requireCondition(bytes.length<=MAX_SOURCE_BYTES&&(!file.sha256||sha256(bytes)===file.sha256),'SOURCE_HASH_MISMATCH','Input file SHA differs');const path=join(workspace,file.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});}
  let settled=false,failed=false,lastAnswer='',pending='',bytesSeen=0,eventChain=Promise.resolve(),eventError:unknown;const decoder=new StringDecoder('utf8');
  const temporary=join(input.folder,'tmp');await mkdir(temporary,{recursive:true,mode:0o700});
  const isolation=await isolatedProcess(process.execPath,[circleBin,'--mode','rpc','--extensions','--yolo',workspace],{read:[input.folder,dirname(circleBin),join(repo,'package.json'),...(await execute('git',['-C',repo,'ls-tree','-r','--name-only',runtime.circleCommit],{maxBuffer:1024*1024})).stdout.split('\n').filter(Boolean).map(path=>join(repo,path)),await realpath(join(repo,'node_modules')),...(process.env.NODE_EXTRA_CA_CERTS?[process.env.NODE_EXTRA_CA_CERTS]:[])],write:[input.folder],network:[input.serverUrl,runtime.model.base_url]});
  const child=spawn(isolation.command,isolation.args,{cwd:workspace,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,TMPDIR:temporary,LANG:process.env.LANG,
    NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,
    HOME:homeUser,CIRCLE_HOME:home,CIRCLE_NO_MODELS_REFRESH:'1',CIRCLE_JOB_WAIT:'120',CIRCLE_SERVER_URL:input.serverUrl,CIRCLE_SERVER_TOKEN:input.serverToken,CIRCLE_SERVER_USER:input.principalId,CIRCLE_SERVER_SCOPE:input.scopeId}});
  const redact=(value:any):any=>typeof value==='string'?value.replaceAll(input.serverToken,'[redacted-run-token]').replaceAll(runtime.model.api_key,'[redacted-model-proxy]').replaceAll(upstreamModelKey,'[redacted-model-key]'):Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[redact(key),redact(item)])):value;
  const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;if(!child.stdin.destroyed){child.stdin.write('{"type":"abort"}\n');child.stdin.end();}};
  const kill=()=>{if(child.exitCode!==null||child.signalCode!==null)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid!,'SIGKILL');}catch{/* process already ended */}};
  let stopTimer:NodeJS.Timeout|undefined;const abort=()=>{onStopping();stop();stopTimer??=setTimeout(kill,5000);};input.signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>{failed=true;abort();},240_000);
  child.stderr.on('data',()=>{/* Runtime paths and credential material never enter logs. */});
  const completion=new Promise<void>((accept,reject)=>{
    child.once('error',()=>reject(new ApiError('RUNTIME_FAILED','Circle process could not be started')));
    child.stdout.on('data',chunk=>{
      bytesSeen+=chunk.length;if(bytesSeen>MAX_SOURCE_BYTES){eventError=new ApiError('RESULT_TOO_LARGE','RPC event stream exceeds the byte limit');abort();return;}
      pending+=decoder.write(chunk);const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines){if(!line.trim())continue;let event:any;try{event=JSON.parse(line);}catch{eventError=new ApiError('RUNTIME_FAILED','Circle returned a non-JSON RPC line');abort();continue;}
        if(event.type==='error'||event.type==='response'&&event.success===false)failed=true;
        if(event.type==='turn_end')lastAnswer=String(event.answer??'');
        if(event.type==='agent_settled'){settled=true;child.stdin.end();}
        eventChain=eventChain.then(()=>input.event(redact(event))).catch(error=>{eventError=error;abort();});
      }
    });
    child.once('exit',code=>{if(code!==0&&!input.signal?.aborted)failed=true;accept();});
  });
  child.stdin.on('error',()=>{/* exit is observed on the child */});
  child.stdin.write(JSON.stringify({id:'run',type:'prompt',message:`Run skill ${input.manifest.id} in this workspace. Read inputs.json and its input files, use the declared server tools, and produce these outputs: ${input.manifest.outputs.join(', ')}. Do not claim delivery without files.`})+'\n');
  try{await completion;await eventChain;}finally{clearTimeout(timeout);if(stopTimer)clearTimeout(stopTimer);input.signal?.removeEventListener('abort',abort);}
  if(input.signal?.aborted)throw new ApiError('RUNTIME_FAILED','Local Circle exit observed after cancellation; remote stopping is unverified',{localExitObserved:true,remoteStoppingVerified:false});
  if(eventError)throw eventError;
  requireCondition(settled&&!failed,'RUNTIME_FAILED','Circle did not settle successfully');
  const outputs=[],canonicalWorkspace=await realpath(workspace);
  for(const name of input.manifest.outputs){SafeRelativePath.parse(name);const path=join(workspace,name);let bytes:Buffer;
    try{const metadata=await lstat(path);requireCondition(metadata.isFile()&&!metadata.isSymbolicLink(),'RUNTIME_FAILED','Declared output is not a regular file');const actual=await realpath(path);requireCondition(!relative(canonicalWorkspace,actual).startsWith('..'),'RUNTIME_FAILED','Declared output escaped its workspace');bytes=await readFile(path);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError('RUNTIME_FAILED','A declared output file is missing');}
    requireCondition(bytes.length<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Runtime output exceeds the byte limit');const redacted=redactBytes(bytes,[input.serverToken,runtime.model.api_key,upstreamModelKey]);bytes=redacted.bytes;const sanitized=redacted.sanitized;
    outputs.push({path:name,contentBase64:bytes.toString('base64'),sha256:sha256(bytes),sanitized});
  }
  return {outputs,answer:redact(lastAnswer),runtime:{circleCommit:commit,circleVersion:version,entrySha256:sha256(await readFile(circleBin)),agentSettled:settled,localExitObserved:true,remoteStoppingVerified:false,model:{kind:runtime.model.kind,model:runtime.model.model},runtimeProfile:input.approvedModel.runtimeProfile}};
}
