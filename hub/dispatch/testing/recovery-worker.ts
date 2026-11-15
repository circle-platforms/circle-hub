// Synthetic recovery process. All database configuration and identities arrive via stdin, never argv/stdout.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openRecords,FileKeyProvider,type ActionBody,type Transaction} from '../../records/api.ts';
import {Database,createPool} from '../../records/db.ts';
import {LeaseService} from '../../leases/api.ts';
import {DispatchService,ExecutorRegistry,MemberEnvironments} from '../api.ts';
import {canUseEnvironment} from '../../records/environment-permissions.ts';
import type {RunDetail,LoadedWorkflow} from '../../ports.ts';
import {effectsDocument} from './effects.ts';

async function main(){
const input=JSON.parse(readFileSync(0,'utf8'));
const now=()=>new Date(input.now);
const kit=await openRecords(input.config,{migrate:false,keyProvider:new FileKeyProvider(join(input.config.dataDir,'test-vault.key')),now});
const db=new Database(createPool(input.config.database,2));
let checkpointReached=false;
function notify(message:Record<string,unknown>){process.send?.(message);}
async function checkpoint(stage:string,facts:Record<string,unknown>={}){
  if(checkpointReached)return;
  checkpointReached=true;
  notify({type:'checkpoint',stage,...facts});
  await new Promise<void>(resolve=>process.on('message',message=>{if(message==='continue')resolve();}));
}
try {
  const detail=input.detail as RunDetail;
  const proof=detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as Record<string,unknown>;
  const bed=proof.bed as {id:string;manifest_sha256:string};
  const document=effectsDocument({target:bed.id,manifest_sha256:bed.manifest_sha256,build:proof.build,sha256:proof.sha256,items:proof.autoids,generator:proof.generator});
  const leases=new LeaseService(db,{now:async()=>now()});
  const environmentAccess=new MemberEnvironments(kit,new ExecutorRegistry(kit),leases,(actor,id,tx)=>canUseEnvironment(kit,actor,id,tx));
  const service=new DispatchService({records:kit,leases,environmentAccess,enforceEnvironmentAssignments:true,now,
    recheckChecks:async({checks})=>Object.fromEntries(checks.map(id=>[id,[{verdict:'support',statement:'合成政策支持',grounds:[],tier:'blocking',data:{parameters:Object.fromEntries(Object.entries(document.effects[0].parameters.values).map(([key,values])=>[key,values[0]]))}}]])),
    runs:{getRun:async(_by,id)=>id===detail.run.run?detail:id===detail.run.predecessor?{...detail,run:{...detail.run,run:id,predecessor:undefined}}:null},
    workflows:{byDigest:async()=>({pack:{id:'synthetic-workflow',version:'1.0.0',digest:detail.run.pack_digest},requirements:document.requirements,readJson:async()=>document} as unknown as LoadedWorkflow)}});
  const watched=['reservation','gate','intent','status.response','result.response'];
  const prior=new Set((watched.includes(input.checkpoint)?await kit.store.findMany<ActionBody>({kind:'action',key:'dispatch.phase',values:[input.checkpoint]}):[]).map(row=>row.digest));
  const transaction=kit.store.withTransaction.bind(kit.store);
  kit.store.withTransaction=async<T>(fn:(tx:Transaction)=>Promise<T>,outer?:Transaction):Promise<T>=>{
    const value=await transaction(fn,outer);
    if(outer===undefined&&!checkpointReached&&watched.includes(input.checkpoint)){
      const rows=await kit.store.findMany<ActionBody>({kind:'action',key:'dispatch.phase',values:[input.checkpoint]});
      const row=rows.find(row=>!prior.has(row.digest)&&row.body.run===detail.run.run&&(input.checkpoint!=='gate'||row.body.detail.allow_submit===true)&&(input.checkpoint!=='result.response'||row.body.detail.complete===true));
      if(row)await checkpoint(input.checkpoint,{job:row.body.detail.job,response:row.digest,inputs:row.body.inputs});
    }
    return value;
  };
  const ingest=kit.artifacts.ingestObservedRead.bind(kit.artifacts);
  kit.artifacts.ingestObservedRead=async(value,tx)=>{
    const source=await ingest(value,tx);
    if(input.checkpoint==='uncommitted-result'&&'read'in value.origin&&value.origin.read.object.endsWith(':result'))await checkpoint('uncommitted-result',{source:source.digest,sha256:source.body.sha256});
    return source;
  };
  const start=new Promise<void>(resolve=>process.once('message',()=>resolve()));
  notify({type:'ready'});await start;
  await service.initializeRecovery();
  if(input.mode==='dispatch'){
    const result=await service.dispatch(input.admin,detail.run.run,input.executor);
    notify({type:'dispatch-done',job:result.job});
  } else {
    await service.recoverPending();
    notify({type:'scheduled'});
  }
  await new Promise<void>(resolve=>process.on('message',async message=>{
    if(message==='scan'){await service.recoverPending();notify({type:'scheduled'});}
    if(message==='close')resolve();
  }));
  await service.close();
} catch {notify({type:'failed'});process.exitCode=1;}
finally {await db.end();await kit.close();process.disconnect?.();}

}
await main().catch(()=>{process.send?.({type:'failed'});process.exitCode=1;process.disconnect?.();});
