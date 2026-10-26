// A bounded sync resumes its recorded observations and pending pages under the same pack and options.
import {canonicalBytes,sha256Hex,type SourceArtifact} from '../records/api.ts';
import type {KnowledgeContext} from './context.ts';
import {evidenceBytes} from './problem-journal.ts';
import type {SourceLoader} from './sources.ts';
import {ACTION,COMPONENTS} from './store.ts';
export interface SyncCheckpoint {pending:string[];required_builds:string[];captured:Array<{id:string;artifact:string;revision:string|null;manifest:string|null}>}
export const syncCheckpointKey=(product:string,pack:string,options:Record<string,unknown>)=>`${product}/${sha256Hex(evidenceBytes({pack,options}))}`;
export async function loadSyncCheckpoint(context:KnowledgeContext,key:string,loader:SourceLoader):Promise<SyncCheckpoint|null>{
 const row=await context.store.newest<any>({key:'knowledge.sync.checkpoint',value:key,kind:'action'});
 if(!row||row.body.detail.done)return null;
 const bytes=await context.records.objects.get(row.body.detail.sha256);if(!bytes||sha256Hex(bytes)!==row.body.detail.sha256)throw new Error('同步检查点原件缺失或摘要不符；恢复检查点后重试');
 const saved=JSON.parse(Buffer.from(bytes).toString('utf8')) as SyncCheckpoint;
 for(const page of saved.captured){const artifact=await context.records.store.get(page.artifact);if(artifact?.kind!=='source_artifact')throw new Error('同步检查点缺少已读页面的原件；恢复原件后重试');loader.restore(page.id,artifact as SourceArtifact,page.revision,page.manifest);}
 return saved;
}
export async function saveSyncCheckpoint(context:KnowledgeContext,key:string,loader:SourceLoader,options:{pending:string[];required_builds:string[];done:boolean;sync:string}):Promise<void>{
 const captured=await loader.captured();
 const artifact=await context.records.artifacts.ingest({bytes:evidenceBytes({pending:options.pending,required_builds:options.required_builds,captured}),mediaType:'application/json',origin:{generated:{generator:COMPONENTS.sync,inputs:captured.map(page=>`rec:${page.artifact}`)}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false},name:'knowledge-sync-checkpoint.json'});
 const now=context.now().toISOString();
 await context.store.putAction({action:ACTION.parse,run:null,item:null,inputs:[`src:${artifact.body.sha256}`],component:COMPONENTS.sync,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{sync:options.sync,done:options.done,pending:options.pending.length,required_builds:options.required_builds.length,sha256:artifact.body.sha256,artifact:artifact.digest}},[{key:'knowledge.sync.checkpoint',value:key}]);
}
