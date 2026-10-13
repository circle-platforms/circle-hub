import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isolatedProcess} from '../../runtime/src/isolation.ts';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';
import {verifyToolImports,validateHookInput,type HookHandler} from './hooks.ts';
export function toolArgument(value:any):any{if(Buffer.isBuffer(value)||value instanceof Uint8Array)return {$bytes:Buffer.from(value).toString('base64')};if(Array.isArray(value))return value.map(toolArgument);return value;}
export async function callFrozenTool(files:Map<string,string>,tools:{manifest:string;imports:Record<string,string>}[],path:string,name:string,args:any[]){
  verifyToolImports(files,tools);requireCondition(tools.some(tool=>tool.manifest===path),'IMPORT_NOT_DECLARED','Select a declared Tool implementation');
  return isolatedCall({files:[...files],tools,path,export:name,args:args.map(toolArgument)});
}
export async function callFrozenHooks(handlers:HookHandler[],inputs:{event:string;binding:any;subject:any}[]){
  for(const item of inputs)validateHookInput(item.event,item);
  if(!handlers.length)return inputs.map((_item,index)=>({index,decisions:[]}));
  const results=[];for(let offset=0;offset<inputs.length;offset+=200){const batch=await isolatedCall({mode:'hooks',handlers,inputs:inputs.slice(offset,offset+200)});for(const item of batch)results.push({...item,index:item.index+offset});if(batch.some((item:any)=>item.decisions.some((decision:any)=>decision.result.decision==='block')))break;}return results;
}
async function isolatedCall(request:any){
  const isolation=await isolatedProcess(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./tool-host.ts',import.meta.url))],{read:[fileURLToPath(new URL('./',import.meta.url)),fileURLToPath(new URL('../../contracts/src/',import.meta.url)),fileURLToPath(new URL('../../../package.json',import.meta.url)),fileURLToPath(new URL('../../../node_modules/',import.meta.url))],write:[],network:[]});
  const child=spawn(isolation.command,isolation.args,{detached:process.platform!=='win32',env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid!,'SIGKILL');}catch{}};let output='',oversized=false;child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>16*1024*1024){oversized=true;kill();}});child.stderr.resume();
  const timer=setTimeout(kill,10_000);child.stdin.end(JSON.stringify(request));
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
  requireCondition(!oversized,'RESULT_TOO_LARGE','Tool result exceeds its byte limit');requireCondition(code===0,'HOOK_FAILED','Frozen Tool did not complete');
  let result:any;try{result=JSON.parse(output);}catch{throw new ApiError('HOOK_FAILED','Frozen Tool did not return JSON');}if(result.error)throw new ApiError(result.error.code,result.error.message,result.error.details);return result.result;
}
