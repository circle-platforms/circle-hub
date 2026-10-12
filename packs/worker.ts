import {ApiError,sha256} from '../packages/contracts/src/index.ts';
import {WorkerClaim} from './apv/contracts.ts';
import {compileMindmap} from './apv/methods/mindmap.ts';
import {SyntheticDevice} from './synthetic/device.ts';
import {ConnectorSDK} from './synthetic/connectors.ts';
import {executeCases,type CaseWorkerContext} from './apv/execution/worker.ts';
import './apv/execution/contracts.ts';

export function installedWorkerMethods(directory?:string){
  const connectors=directory?new ConnectorSDK(directory):undefined;
  return {
    backgroundNames:new Set(['cases.execute','cases.observe']),
    initialize:async()=>{await connectors?.initialize();},
    execute:async(raw:any,context:{check:()=>Promise<any>;source:()=>Promise<Buffer>;signal:AbortSignal;directory:string;event:(event:any)=>Promise<any>})=>{
      if(['cases.verify','cases.execute','cases.observe'].includes(raw.name))return executeCases(raw,context);
      const fence={fencingToken:raw.fencingToken,inputRevisionId:raw.inputRevisionId};
      if(raw.name==='mindmaps.compile'){
        const claim=WorkerClaim.parse(raw),bytes=await context.source();if(sha256(bytes)!==claim.source.sha256)throw new ApiError('SOURCE_HASH_MISMATCH','Worker source hash mismatch');await context.check();
        try{const compiled=await compileMindmap(bytes,claim.source.fileName);return {...fence,status:compiled.status,artifactBase64:compiled.workbook.toString('base64')};}
        catch(error){const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Compiler failed');return {...fence,status:'failed',error:{code:failure.code,message:failure.message}};}
      }
      try{if(!directory||!connectors)throw new ApiError('SOURCE_UNREACHABLE','Synthetic operation driver is not configured');const output=raw.target==='RESOURCE-LAB-01'?await new SyntheticDevice(directory).execute(raw,context.check,context.signal):await connectors.execute(raw,context.check);return {...fence,status:'succeeded',output};}
      catch(error){const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Synthetic driver failed');return {...fence,status:failure.code==='UPSTREAM_TIMEOUT'?'unknown':'failed',output:{},error:{code:failure.code,message:failure.message}};}
    },
  };
}
