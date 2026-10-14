import {canonicalJson,registeredErrorCode,sha256} from '../../contracts/src/index.ts';

// Error channels are Hub classifications. Opaque product result trees remain
// product data; their original bytes are retained separately in B.
function opaque(value:any):any{
 if(Array.isArray(value))return value.map(opaque);
 return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,opaque(item)])):value;
}
function hubError(value:any,errorChannel:boolean,withinError:boolean):any{
 if(Array.isArray(value))return value.map(item=>hubError(item,errorChannel,withinError));
 if(!value||typeof value!=='object')return value;
 const currentError=errorChannel||withinError&&Object.hasOwn(value,'code')&&typeof value.message==='string';
 return Object.fromEntries(Object.entries(value).map(([key,item])=>{const channel=key==='error'||key==='resultError';return [key,key==='code'&&currentError?(registeredErrorCode(item)?item:'INTERNAL_ERROR'):hubError(item,channel,withinError||channel)];}));
}
export function projectWorkerErrors(value:any,errorChannel=false,withinError=errorChannel):any{
 if(errorChannel||withinError)return hubError(value,errorChannel,withinError);
 if(!value||typeof value!=='object'||Array.isArray(value))return opaque(value);
 // Only these report-envelope paths establish a Hub error channel. Product
 // result trees remain opaque even when their own keys are named error.
 return Object.fromEntries(Object.entries(value).map(([key,item])=>{
  if(key==='error')return [key,hubError(item,true,true)];
  if(key==='output'&&item&&typeof item==='object'&&!Array.isArray(item))return [key,Object.fromEntries(Object.entries(item).map(([field,part])=>[field,field==='resultError'?hubError(part,true,true):opaque(part)]))];
  return [key,opaque(item)];
 }));
}

export async function retainWorkerReport(knowledge:any,tx:any,task:any,operationId:string,body:unknown){
 const bytes=Buffer.from(canonicalJson(body));return knowledge.materialize(tx,task,`worker-report-${operationId}-${sha256(bytes)}`,`worker-report-${operationId}.json`,'application/json',bytes,{operationId,transformation:'canonical-worker-report-json'});
}
