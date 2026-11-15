import type {RecordsKit} from '../records/api.ts';
import type {Journal,JobBinding} from './journal.ts';
import type {ResponseMetadata} from './transport.ts';
import type {LeaseOp} from '../../contracts/generated/vocabulary.ts';

/** A response is not available to interpretation until both its source and journal link commit. */
export async function captureResponse(input:{
  records:Pick<RecordsKit,'store'>;journal:Pick<Journal,'raw'|'append'>;binding:JobBinding;
  bytes:Uint8Array;status:number;operation:string;complete:boolean;metadata?:ResponseMetadata;
}):Promise<string>{
  const {records,journal,binding,bytes,status,operation,complete,metadata}=input;
  return records.store.withTransaction(async tx=>{
    const captured=await journal.raw(binding,bytes,operation,complete,tx);
    const op:LeaseOp|undefined=operation==='acquire'?'acquire':operation==='heartbeat'?'extend':operation==='release'?'release':undefined;
    const {received_sha256,...publicMetadata}=metadata??{};
    if(metadata?.redacted&&binding.input)await journal.append({...binding,input:null},operation+'.private_response','read','completed',{received_sha256,redacted:true},[],undefined,tx);
    const visibleMetadata=metadata?.redacted&&binding.input?publicMetadata:metadata;
    await journal.append(binding,operation+'.response',op?'lease':operation==='submit'?'dispatch':'read',complete?'completed':operation==='submit'?'unknown':'error',
      {...(op?{op}:{}),http_status:status,complete,source_record:captured.record,...visibleMetadata},[captured.reference,captured.record],undefined,tx);
    return captured.reference;
  });
}
