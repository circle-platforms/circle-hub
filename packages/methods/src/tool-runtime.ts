import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';
import {verifyToolImports} from './hooks.ts';
export function toolArgument(value:any):any{if(Buffer.isBuffer(value)||value instanceof Uint8Array)return {$bytes:Buffer.from(value).toString('base64')};if(Array.isArray(value))return value.map(toolArgument);return value;}
export async function callFrozenTool(files:Map<string,string>,tools:{manifest:string;imports:Record<string,string>}[],path:string,name:string,args:any[]){
  verifyToolImports(files,tools);requireCondition(tools.some(tool=>tool.manifest===path),'IMPORT_NOT_DECLARED','Select a declared Tool implementation');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./tool-host.ts',import.meta.url))],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});let output='',oversized=false;child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>16*1024*1024){oversized=true;child.kill('SIGKILL');}});child.stderr.resume();
  const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);child.stdin.end(JSON.stringify({files:[...files],tools,path,export:name,args:args.map(toolArgument)}));
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
  requireCondition(!oversized,'RESULT_TOO_LARGE','Tool result exceeds its byte limit');requireCondition(code===0,'HOOK_FAILED','Frozen Tool did not complete');
  let result:any;try{result=JSON.parse(output);}catch{throw new ApiError('HOOK_FAILED','Frozen Tool did not return JSON');}if(result.error)throw new ApiError(result.error.code,result.error.message,result.error.details);return result.result;
}
