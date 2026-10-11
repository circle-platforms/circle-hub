import { mkdir,readFile,writeFile,rename,rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError,canonicalHash,requireCondition } from '../../contracts/src/index.ts';

export class SyntheticDevice {
  directory:string;
  constructor(directory:string) { this.directory=directory; }
  async execute(job:any,recheck:()=>Promise<unknown>,signal?:AbortSignal):Promise<Record<string,unknown>> {
    requireCondition(job.target === 'LBX-LAB-01','TARGET_NOT_FOUND','Only the synthetic LBX device is supported');
    const hold=Number(job.args.holdAfterEffectMs ?? 0);
    requireCondition(Number.isInteger(hold) && hold>=0 && hold<=120_000,'INVALID_PAYLOAD','Invalid synthetic receipt delay');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const file=join(this.directory,'LBX-LAB-01.json'),lock=`${file}.lock`;
    let held=false;
    for(let i=0;i<100;i++) { try{await mkdir(lock);held=true;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await delay(10);} }
    requireCondition(held,'RESOURCE_BUSY','Synthetic device is locked');
    let output:Record<string,unknown>;
    try {
      let state:any;
      try{state=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        state={synthetic:true,identity:'synthetic-host-key:lbx-01',product:'LBX',version:'8.4.2',config:{'backend.timeout':5},fencing:0,receipts:{},writes:[]};}
      requireCondition(state.synthetic === true,'FORBIDDEN_TARGET','Resource is not an authorized synthetic device');
      // Check both the live authority and the endpoint's observed host identity at the last exit point.
      await recheck();
      requireCondition(state.identity === job.targetIdentity,'TARGET_IDENTITY_MISMATCH','Observed host key changed at the executing endpoint');
      requireCondition(job.fencingToken >= state.fencing,'FENCING_STALE','Endpoint rejected an old fencing token');
      state.fencing=job.fencingToken;
      if(job.kind==='reconcile') {
        const receipt=state.receipts[job.parentOperationId];
        output={observation:receipt ? {completed:true,operationId:job.parentOperationId,...receipt} : {completed:false,operationId:job.parentOperationId},
          actualState:{identity:state.identity,config:state.config},observedStateSha256:canonicalHash(state)};
      } else {
        if(job.name==='product.config.write') {
          requireCondition(job.args.key==='backend.timeout' && typeof job.args.value==='number' && Number.isFinite(job.args.value),'INVALID_PAYLOAD','Synthetic driver supports the declared numeric setting only');
          state.config[job.args.key]=job.args.value;state.writes.push({operationId:job.operationId,key:job.args.key,value:job.args.value,fencingToken:job.fencingToken});
        } else requireCondition(['product.config.read','product.version'].includes(job.name),'INVALID_PAYLOAD','Unsupported synthetic device operation');
        output={product:state.product,version:state.version,identity:state.identity,config:{...state.config},synthetic:true};
        state.receipts[job.operationId]={outcome:'succeeded',actionDigest:job.actionDigest,fencingToken:job.fencingToken,output};
      }
      const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,file);
    } finally {await rmdir(lock);}
    if(hold)await delay(hold,undefined,{signal});
    return output;
  }
}
