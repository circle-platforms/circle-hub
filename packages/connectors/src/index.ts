import {mkdir,readFile,writeFile,rename,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError,ConnectorManifest,STANDARD_OPERATIONS,canonicalHash,sha256,requireCondition} from '../../contracts/src/index.ts';

const op=(name:keyof typeof STANDARD_OPERATIONS,idempotency:'none'|'marker'|'content-hash',reconciliation:'read-back'|'content-hash')=>({name,effects:STANDARD_OPERATIONS[name],idempotency,reconciliation});
export const CONNECTOR_MANIFESTS:ConnectorManifest[]=[
  ...['bugzilla-synthetic','jira-synthetic'].map(id=>ConnectorManifest.parse({id,version:'1.0.0',synthetic:true,roles:['defects'],operations:[op('defects.search','none','read-back'),op('defects.comment','marker','read-back')],events:{mode:'cursor-poll'}})),
  ConnectorManifest.parse({id:'openkm-synthetic',version:'1.0.0',synthetic:true,roles:['documents'],operations:[op('docs.fetch','none','content-hash'),op('docs.convert','content-hash','content-hash')],events:{mode:'none'}}),
];
export const connectorIdentity=(id:string):string=>`synthetic-connector:${id}`;
const manual=Buffer.from(JSON.stringify({product:'LBX',versionSeries:'8.4',section:'6.4',backendTimeoutMinimum:10}));
function initial(id:string):any {
  if(id==='openkm-synthetic')return {synthetic:true,identity:connectorIdentity(id),documents:{'lbx-8.4-healthcheck':{fileName:'LBX-8.4-manual-6.4.json',contentBase64:manual.toString('base64')}},receipts:{}};
  return {synthetic:true,identity:connectorIdentity(id),defects:{'LAB-42':{id:'LAB-42',title:'Synthetic health check timeout below minimum',product:'LBX',version:'8.4.2',observedTimeout:5,comments:[]},
    'SECRET-99':{id:'SECRET-99',title:'Owner cannot see this synthetic defect',product:'LBX',version:'8.4.2',comments:[]}},
    events:[{cursor:1,externalId:'defect-42-updated',defectId:'LAB-42'},{cursor:2,externalId:'secret-99-updated',defectId:'SECRET-99'}],receipts:{}};
}
export class ConnectorSDK {
  directory:string;
  constructor(directory:string){this.directory=directory;}
  async initialize():Promise<void>{await mkdir(this.directory,{recursive:true,mode:0o700});for(const manifest of CONNECTOR_MANIFESTS){
    try{await writeFile(join(this.directory,`${manifest.id}.json`),JSON.stringify(initial(manifest.id)),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }}
  async execute(job:any,recheck:()=>Promise<any>):Promise<Record<string,unknown>>{
    const manifest=CONNECTOR_MANIFESTS.find(item=>item.id===job.target);requireCondition(manifest,'TARGET_NOT_FOUND','Unknown synthetic connector');
    const readName=job.kind==='reconcile'?(job.name==='defects.comment'?'defects.search':job.name==='docs.convert'?'docs.fetch':job.name):job.name;
    requireCondition(manifest.operations.some(item=>item.name===readName),'INVALID_PAYLOAD','Connector has not declared this operation');
    const file=join(this.directory,`${manifest.id}.json`),lock=`${file}.lock`;let held=false;
    for(let attempt=0;attempt<100;attempt++){try{await mkdir(lock);held=true;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await delay(10);}}
    requireCondition(held,'RESOURCE_BUSY','Synthetic connector is locked');
    let output:any;
    try{
      const checked=await recheck(),authorization=checked.authorization;
      requireCondition(authorization,'FORBIDDEN_ACTION','Connector requires live authenticated authorization');
      const state=JSON.parse(await readFile(file,'utf8'));requireCondition(state.synthetic===true,'FORBIDDEN_TARGET','Only synthetic connector state is allowed');
      requireCondition(state.identity===job.targetIdentity,'TARGET_IDENTITY_MISMATCH','Connector identity changed');
      const defectId=job.args.defectId;
      if(job.name.startsWith('defects.')&&defectId)requireCondition(authorization.defects.includes(defectId),'FORBIDDEN_TARGET','Defect is outside the effective owner/service visibility');
      if(job.kind==='reconcile'){
        const receipt=state.receipts[job.parentOperationId],marker=`[circle ${job.parentOperationId}]`;
        const found=job.name==='defects.comment'?state.defects[defectId]?.comments.find((comment:any)=>comment.marker===marker&&comment.actionDigest===job.actionDigest):receipt;
        output={observation:found?{completed:true,operationId:job.parentOperationId,outcome:'succeeded',actionDigest:found.actionDigest,marker:found.marker}: {completed:false,operationId:job.parentOperationId},readBack:true};
      }else if(job.name==='defects.search'){
        if(defectId)output={defects:[state.defects[defectId]].filter(Boolean),cursor:Math.max(0,...state.events.map((event:any)=>event.cursor))};
        else output={events:state.events.filter((event:any)=>event.cursor>Number(job.args.cursor??0)&&authorization.defects.includes(event.defectId)),
          cursor:Math.max(Number(job.args.cursor??0),...state.events.map((event:any)=>event.cursor))};
      }else if(job.name==='defects.comment'){
        const defect=state.defects[defectId];requireCondition(defect,'TARGET_NOT_FOUND','Defect not found');
        const marker=`[circle ${job.operationId}]`,text=`${String(job.args.text??'') } ${marker}`;
        let comment=defect.comments.find((item:any)=>item.marker===marker);
        if(!comment){comment={id:`comment-${defect.comments.length+1}`,marker,text,author:authorization.principalId,actionDigest:job.actionDigest};defect.comments.push(comment);}
        requireCondition(comment.actionDigest===job.actionDigest,'IDEMPOTENCY_MISMATCH','Marker has another action binding');
        output={commentId:comment.id,marker,textSha256:sha256(Buffer.from(comment.text)),readBack:true};
        state.receipts[job.operationId]={outcome:'succeeded',actionDigest:job.actionDigest,output};
      }else{
        const document=state.documents[job.args.documentId];requireCondition(document,'TARGET_NOT_FOUND','Document not found');
        const original=Buffer.from(document.contentBase64,'base64'),digest=sha256(original);
        if(job.name==='docs.fetch')output={documentId:job.args.documentId,fileName:document.fileName,originalBase64:document.contentBase64,sourceSha256:digest};
        else{
          const parsed=JSON.parse(original.toString());requireCondition(parsed.product==='LBX'&&typeof parsed.backendTimeoutMinimum==='number','INVALID_PAYLOAD','Unsupported synthetic document conversion');
          const converted=Buffer.from(`${parsed.product} ${parsed.versionSeries} section ${parsed.section}\nbackend.timeout minimum = ${parsed.backendTimeoutMinimum}\n`);
          output={documentId:job.args.documentId,fileName:'LBX-8.4-manual-6.4.txt',mediaType:'text/plain',convertedBase64:converted.toString('base64'),sourceSha256:digest,convertedSha256:sha256(converted),conversion:'synthetic-json-to-text/1'};
        }
      }
      const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,file);
    }finally{await rmdir(lock);}
    if(job.kind!=='reconcile'&&job.name==='defects.comment'&&job.args.simulateTimeoutAfterWrite===true)throw new ApiError('UPSTREAM_TIMEOUT','Synthetic comment effect completed but its reply timed out');
    return output;
  }
}
