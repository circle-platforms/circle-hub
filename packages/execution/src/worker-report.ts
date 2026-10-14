import {canonicalJson,registeredErrorCode,sha256} from '../../contracts/src/index.ts';

// Error channels are Hub classifications. Opaque product result.code fields
// remain product data; their original bytes are retained separately in B.
export function projectWorkerErrors(value:any,errorChannel=false,withinError=errorChannel):any{
 if(Array.isArray(value))return value.map(item=>projectWorkerErrors(item,errorChannel,withinError));
 if(!value||typeof value!=='object')return value;
 const currentError=errorChannel||withinError&&Object.hasOwn(value,'code')&&typeof value.message==='string';
 return Object.fromEntries(Object.entries(value).map(([key,item])=>{const channel=key==='error'||key==='resultError';return [key,key==='code'&&currentError?(registeredErrorCode(item)?item:'INTERNAL_ERROR'):projectWorkerErrors(item,channel,withinError||channel)];}));
}

export async function retainWorkerReport(knowledge:any,tx:any,task:any,operationId:string,body:unknown){
 const bytes=Buffer.from(canonicalJson(body));return knowledge.materialize(tx,task,`worker-report-${operationId}-${sha256(bytes)}`,`worker-report-${operationId}.json`,'application/json',bytes,{operationId,transformation:'canonical-worker-report-json'});
}
