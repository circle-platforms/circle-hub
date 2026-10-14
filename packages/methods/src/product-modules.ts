import {z} from 'zod';
import {SafeRelativePath,canonicalHash,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';
import type {SourceArtifacts,AssetRevisionPin} from '../../knowledge/src/source-artifacts.ts';
import {HookRuntime,HOOK_EVENTS,verifyToolImports,type HookHandler} from './hooks.ts';
import {callFrozenTool,callFrozenHooks} from './tool-runtime.ts';
const definition=z.object({schemaVersion:z.literal('product-line/1'),id:z.string(),version:z.string(),tools:z.array(z.object({manifest:SafeRelativePath,imports:z.record(z.string(),z.string())}).strict()).default([]),hooks:z.array(z.object({manifest:SafeRelativePath,event:z.enum(HOOK_EVENTS),order:z.number().int()}).strict()).default([]),flows:z.array(SafeRelativePath).default([]),resources:z.array(SafeRelativePath).default([])}).passthrough();
export function verifyProductLine(manifest:any,files:Map<string,string>){
  const parsed=definition.parse(manifest);verifyToolImports(files,parsed.tools);
  for(const path of [...parsed.hooks.map(hook=>hook.manifest),...parsed.flows,...parsed.resources])requireCondition(files.has(path),'SOURCE_HASH_MISMATCH','Declared file is absent from its frozen module');
  // Compile all handlers at admission, including events not used by this run.
  for(const hook of parsed.hooks)new HookRuntime().validate(files.get(hook.manifest)!);
  return parsed;
}
interface Loaded{manifest:z.infer<typeof definition>;handlers:HookHandler[];flows:any[];files:Map<string,string>}
export class ProductModules{
  sources:SourceArtifacts;runtime=new HookRuntime();cache=new Map<string,Loaded>();
  constructor(sources:SourceArtifacts){this.sources=sources;}
  async load(ctx:AuthContext,assetId:string,scope:string,tx?:Transaction,pin?:AssetRevisionPin){
    const snapshot=await this.sources.snapshot(ctx,assetId,scope,tx,pin);
    requireCondition(snapshot.metadata.module?.kind==='product-line','SOURCE_NOT_APPROVED','Select an approved product-line module');
    const key=canonicalHash([snapshot.assetId,snapshot.assetVersion,snapshot.assetSha256]);let loaded=this.cache.get(key);
    if(!loaded){
      const originals=await this.sources.bytes(ctx,snapshot,scope,tx),files=new Map(originals.map(raw=>[raw.path.replace(/^\//,''),raw.bytes.toString('utf8')])),manifest=verifyProductLine(snapshot.metadata.manifest,files);
      const handlers=manifest.hooks.map(hook=>({id:`${manifest.id}.${hook.manifest.replace(/\.ts$/,'').replaceAll('/','.')}`,version:manifest.version,event:hook.event,order:hook.order,code:files.get(hook.manifest)!}));
      loaded={manifest,handlers,flows:manifest.flows.map(path=>JSON.parse(files.get(path)!)),files};this.cache.set(key,loaded);
    }
    return {...loaded,binding:{assetId:snapshot.assetId,version:snapshot.assetVersion,sha256:snapshot.assetSha256,digest:snapshot.metadata.module.digest}};
  }
  async call(ctx:AuthContext,assetId:string,scope:string,path:string,name:string,args:any[],tx?:Transaction,pin?:AssetRevisionPin){const loaded=await this.load(ctx,assetId,scope,tx,pin);return callFrozenTool(loaded.files,loaded.manifest.tools,path,name,args);}
  async runBatch(ctx:AuthContext,assetId:string|undefined,scope:string,inputs:{event:string;binding:any;subject:any}[],tx?:Transaction,pin?:AssetRevisionPin){const handlers=assetId?(await this.load(ctx,assetId,scope,tx,pin)).handlers:[];return callFrozenHooks(handlers,inputs);}
  async run(ctx:AuthContext,assetId:string|undefined,scope:string,event:string,binding:any,subject:any,tx?:Transaction,pin?:AssetRevisionPin){return (await this.runBatch(ctx,assetId,scope,[{event,binding,subject}],tx,pin))[0].decisions;}
}
