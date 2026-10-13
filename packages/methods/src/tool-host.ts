// Resolve only imports already checked against the frozen Tool file set.
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import {webcrypto} from 'node:crypto';
import {verifyToolImports,TOOL_DEPENDENCIES} from './hooks.ts';
const requireDependency=createRequire(import.meta.url);
let line='';
for await(const chunk of process.stdin){line+=chunk;if(Buffer.byteLength(line)>24*1024*1024)throw new Error('Tool input exceeds its bound');}
const request=JSON.parse(line),files=new Map<string,string>(request.files);
verifyToolImports(files,request.tools);
const context=vm.createContext({Buffer,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,crypto:{subtle:webcrypto.subtle},console:{log:()=>{},warn:()=>{},error:()=>{}}},{codeGeneration:{strings:false,wasm:false}}),loaded=new Map<string,any>();
function load(path:string):any{
  if(loaded.has(path))return loaded.get(path);
  const code=files.get(path);if(code===undefined)throw new Error('Frozen Tool is missing');
  const module={exports:{} as any};loaded.set(path,module.exports);
  const localRequire=(name:string)=>name.startsWith('.')?load(posix.normalize(posix.join(posix.dirname(path),name))):Object.hasOwn(TOOL_DEPENDENCIES,name)?requireDependency(name):(()=>{throw new Error('IMPORT_NOT_DECLARED');})();
  const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new vm.Script(`(function(exports,require,module){'use strict';${js}\n})`,{filename:path}).runInContext(context,{timeout:200})(module.exports,localRequire,module);return module.exports;
}
function argument(value:any):any{if(value?.$bytes)return Buffer.from(value.$bytes,'base64');if(value?.$instance){const entry=value.$instance;return new (load(entry.path)[entry.export])(...entry.args.map(argument));}if(Array.isArray(value))return value.map(argument);return value;}
try{
  const fn=load(request.path)[request.export];if(typeof fn!=='function')throw new Error('Tool export is missing');
  const result=await fn(...request.args.map(argument));process.stdout.write(JSON.stringify({result}));
}catch(error:any){process.stdout.write(JSON.stringify({error:{code:error.code??'HOOK_FAILED',message:error.message??'Tool failed',details:error.details??{}}}));}
