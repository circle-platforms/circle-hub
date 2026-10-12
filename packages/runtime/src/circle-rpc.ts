import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {ApiError,MAX_SOURCE_BYTES,SafeRelativePath,canonicalJson,requireCondition,sha256} from '../../contracts/src/index.ts';

const execute=promisify(execFile);
export interface CircleRun {
  runtime:{circleBin:string;circleCommit:string;circleVersion:string;model:{kind:'scripted';base_url:string;model:string;protocol:string;api_key:string}};
  folder:string;manifest:any;files:{path:string;bytes:Buffer;sha256:string}[];inputs:Record<string,unknown>;
  serverUrl:string;serverToken:string;scopeId:string;principalId:string;signal?:AbortSignal;
  event:(event:any)=>Promise<void>;
}
export async function runCircle(input:CircleRun):Promise<any>{
  const {runtime}=input,circleBin=resolve(runtime.circleBin),repo=dirname(dirname(circleBin));
  const home=join(input.folder,'home'),homeUser=join(input.folder,'home-user'),workspace=join(input.folder,'workspace');
  for(const directory of [home,homeUser,workspace])await mkdir(directory,{recursive:true,mode:0o700});
  let version:string,commit:string;
  try{version=(await execute(process.execPath,[circleBin,'--version'],{timeout:5000,env:{PATH:process.env.PATH,HOME:homeUser,CIRCLE_HOME:home,CIRCLE_NO_MODELS_REFRESH:'1'}})).stdout.trim();commit=(await execute('git',['-C',repo,'rev-parse','HEAD'],{timeout:5000})).stdout.trim();}
  catch{throw new ApiError('RUNTIME_VERSION_MISMATCH','Circle executable or Git revision cannot be verified');}
  requireCondition(version===runtime.circleVersion&&commit===runtime.circleCommit,'RUNTIME_VERSION_MISMATCH','Circle version or Git revision differs from the pinned runtime');
  const modelUrl=new URL(runtime.model.base_url);requireCondition(runtime.model.kind==='scripted'&&modelUrl.hostname==='127.0.0.1'&&modelUrl.protocol==='http:','FORBIDDEN_ACTION','Development runtime permits only a loopback scripted model');
  await writeFile(join(home,'settings.json'),JSON.stringify({version:1,initialized:true,auth:{base_url:runtime.model.base_url,model:runtime.model.model,protocol:runtime.model.protocol,api_key_ref:'api_key'},trusted_folders:[workspace],extensions:{'circle-server':{enabled:true}},mcp_servers:[],update_check:false}),{mode:0o600});
  await writeFile(join(home,'credentials.json'),JSON.stringify({api_key:runtime.model.api_key}),{mode:0o600});
  const skillRoot=join(workspace,'.circle','skills',input.manifest.id);
  for(const file of input.files){SafeRelativePath.parse(file.path);requireCondition(sha256(file.bytes)===file.sha256,'SOURCE_HASH_MISMATCH','Skill blob SHA differs');const path=join(skillRoot,file.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,file.bytes,{mode:0o600});}
  await writeFile(join(workspace,'inputs.json'),canonicalJson(input.inputs),{mode:0o600});
  if(Array.isArray(input.inputs.files))for(const file of input.inputs.files as any[]){SafeRelativePath.parse(file.path);requireCondition(!file.path.split('/').some((part:string)=>part.startsWith('.')||part.toLowerCase()==='agents.md')&&file.path!=='inputs.json'&&!input.manifest.outputs.includes(file.path),'INVALID_PAYLOAD','Input files cannot replace runtime control files or declared outputs');requireCondition(typeof file.base64==='string','INVALID_PAYLOAD','Input files require base64 bytes');const bytes=Buffer.from(file.base64,'base64');requireCondition(bytes.length<=MAX_SOURCE_BYTES&&(!file.sha256||sha256(bytes)===file.sha256),'SOURCE_HASH_MISMATCH','Input file SHA differs');const path=join(workspace,file.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});}
  let settled=false,failed=false,lastAnswer='',pending='',bytesSeen=0,eventChain=Promise.resolve(),eventError:unknown;const decoder=new StringDecoder('utf8');
  const child=spawn(process.execPath,[circleBin,'--mode','rpc','--extensions','--yolo',workspace],{cwd:workspace,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG,
    HOME:homeUser,CIRCLE_HOME:home,CIRCLE_NO_MODELS_REFRESH:'1',CIRCLE_JOB_WAIT:'120',CIRCLE_SERVER_URL:input.serverUrl,CIRCLE_SERVER_TOKEN:input.serverToken,CIRCLE_SERVER_USER:input.principalId,CIRCLE_SERVER_SCOPE:input.scopeId}});
  const redact=(value:unknown):any=>JSON.parse(JSON.stringify(value).replaceAll(input.serverToken,'[redacted-run-token]').replaceAll(runtime.model.api_key,'[redacted-model-key]'));
  const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;if(!child.stdin.destroyed){child.stdin.write('{"type":"abort"}\n');child.stdin.end();}};
  const kill=()=>{if(child.exitCode!==null||child.signalCode!==null)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid!,'SIGKILL');}catch{/* process already ended */}};
  let stopTimer:NodeJS.Timeout|undefined;const abort=()=>{stop();stopTimer??=setTimeout(kill,5000);};input.signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>{failed=true;abort();},240_000);
  child.stderr.on('data',()=>{/* CLI stderr may contain runtime paths; errors are summarized without raw logging. */});
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
    requireCondition(bytes.length<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Runtime output exceeds the byte limit');requireCondition(!bytes.includes(Buffer.from(input.serverToken)),'RUNTIME_FAILED','Runtime output contains a private run credential');
    outputs.push({path:name,contentBase64:bytes.toString('base64'),sha256:sha256(bytes)});
  }
  return {outputs,answer:lastAnswer,runtime:{circleCommit:commit,circleVersion:version,entrySha256:sha256(await readFile(circleBin)),agentSettled:settled,localExitObserved:true,remoteStoppingVerified:false,model:{kind:'scripted',model:runtime.model.model}}};
}
