import vm from 'node:vm';
import ts from 'typescript';
import {posix} from 'node:path';
import {ApiError,requireCondition,canonicalHash} from '../../contracts/src/index.ts';
import {z} from 'zod';
export const HOOK_EVENTS=['verify.deviceCommand','verify.hostCommand','verify.workbook','beforeDispatch','afterResult'] as const;
export const TOOL_DEPENDENCIES:Record<string,string>={exceljs:'4.4.0','read-excel-file':'9.3.12',fflate:'0.8.3',zod:'4.6.5',saxes:'5.0.1',parse5:'8.0.1'};
export interface HookHandler{id:string;version:string;event:string;order:number;code:string;sha256?:string}
const command=z.string().max(16384);
export const HookSubjects={
  'verify.deviceCommand':z.object({command,tree:z.object({heads:z.array(z.object({command,present:z.boolean()}).strict()).max(5000)}).strict()}).strict(),
  'verify.hostCommand':z.object({command,host:z.string().min(1).max(200),method:z.string().min(1).max(200),kwargs:z.record(z.string(),z.union([z.string(),z.number()]))}).strict(),
  'verify.workbook':z.object({client:z.string().max(200),contract:z.object({testEnvEnabled:z.array(z.string().max(200)).max(10000)}).strict()}).strict(),
  beforeDispatch:z.object({input:z.record(z.string(),z.unknown()),operationId:z.string().min(1),preparations:z.array(z.object({index:z.number().int().nonnegative(),tool:z.string().min(1),reference:z.object({artifactId:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().positive()}).strict(),result:z.record(z.string(),z.unknown())}).strict()).max(256).optional()}).strict(),afterResult:z.object({result:z.record(z.string(),z.unknown()),operationId:z.string().min(1)}).strict(),
};
export const HookResource=z.object({assetId:z.string().min(1),version:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),declaration:z.object({allowedTestHosts:z.array(z.string()).optional(),hostCommandPolicies:z.record(z.string(),z.object({allowPrefixes:z.array(z.string()).optional()}).passthrough()).optional()}).passthrough()}).strict();
export function validateHookInput(event:string,input:{binding:any;subject:any}){const parsed=z.enum(HOOK_EVENTS).parse(event);z.object({method:z.unknown(),resource:HookResource,source:z.unknown(),inputRevision:z.unknown()}).strict().parse(input.binding);for(const key of ['method','resource','source','inputRevision'])requireCondition(Object.hasOwn(input.binding,key),'INVALID_PAYLOAD','Hook binding is incomplete');HookSubjects[parsed].parse(input.subject);}
function imports(path:string,code:string){const source=ts.createSourceFile(path,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),values:string[]=[];
  const visit=(node:ts.Node)=>{let expression:ts.Expression|undefined;if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))expression=node.moduleSpecifier;else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))expression=node.arguments[0];else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))expression=node.moduleReference.expression;
    if(expression){if(!ts.isStringLiteralLike(expression))throw new ApiError('IMPORT_NOT_DECLARED','Computed imports cannot be loaded',{path});values.push(expression.text);}ts.forEachChild(node,visit);};visit(source);return values;
}
export function verifyToolImports(files:Map<string,string>,tools:{manifest:string;imports:Record<string,string>}[]){const definitions=new Map(tools.map(tool=>[tool.manifest,tool.imports])),seen=new Set<string>();
  function check(path:string){if(seen.has(path))return;seen.add(path);const code=files.get(path);requireCondition(code!==undefined,'IMPORT_NOT_DECLARED','Imported module is outside the frozen file set');for(const name of imports(path,code)){if(name.startsWith('.')){const target=posix.normalize(posix.join(posix.dirname(path),name));requireCondition(!target.startsWith('../')&&files.has(target),'IMPORT_NOT_DECLARED','Relative import is outside its module');check(target);}else{const declared=definitions.get(path)?.[name];if(!Object.hasOwn(TOOL_DEPENDENCIES,name)||declared!==TOOL_DEPENDENCIES[name])throw new ApiError('IMPORT_NOT_DECLARED','Tool import is not declared in its supported dependency set',{path,import:name});}}}
  for(const tool of tools){for(const [name,version]of Object.entries(tool.imports))requireCondition(Object.hasOwn(TOOL_DEPENDENCIES,name)&&TOOL_DEPENDENCIES[name]===version,'IMPORT_NOT_DECLARED','Declared dependency version is not supported');check(tool.manifest);}
}
export class HookRuntime{
  cache=new Map<string,string>();
  validate(code:string){requireCondition(imports('hook',code).length===0,'IMPORT_NOT_DECLARED','Hook imports must be sealed into the handler');return ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
  run(handlers:HookHandler[],event:string,input:{binding:any;subject:any}){
    validateHookInput(event,input);
    const decisions=[];for(const handler of handlers.filter(handler=>handler.event===event).sort((a,b)=>a.order-b.order||(a.id<b.id?-1:1))){let compiled=this.cache.get(canonicalHash(handler.code));if(!compiled){compiled=this.validate(handler.code);this.cache.set(canonicalHash(handler.code),compiled);}
      const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}}),payload=JSON.stringify({event,binding:input.binding,subject:input.subject});let result:any;
      try{const script=new vm.Script(`'use strict';const exports=Object.create(null);const module={exports};globalThis.process=undefined;globalThis.fetch=undefined;globalThis.Date=undefined;Math.random=()=>{throw new Error('Non deterministic hook');};${compiled}\nJSON.stringify(exports.default(JSON.parse(${JSON.stringify(payload)})));`);result=JSON.parse(script.runInContext(context,{timeout:100}));}catch{throw new ApiError('HOOK_FAILED','Hook did not return a deterministic result',{ruleId:handler.id,ruleVersion:handler.version});}
      requireCondition(result?.decision==='pass'||result?.decision==='block'&&typeof result.code==='string'&&result.facts&&typeof result.facts==='object'&&!Array.isArray(result.facts),'HOOK_FAILED','Hook returned an invalid result');decisions.push({ruleId:handler.id,ruleVersion:handler.version,event,result});if(result.decision==='block')break;
    }return decisions;
  }
}
