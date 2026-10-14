import type {ObjectStore} from '../../knowledge/src/objects.ts';
import type {RawReturn} from './readonly-sdk.ts';
import {MAX_SOURCE_BYTES,requireCondition,sha256} from '../../contracts/src/index.ts';
export async function freezeReturns(objects:ObjectStore,returns:RawReturn[],sourceType:string){
  const raw=[];for(const item of returns){requireCondition(item.bytes.length<=MAX_SOURCE_BYTES&&sha256(item.bytes)===item.sha256,'SOURCE_HASH_MISMATCH','Worker source bytes differ');await objects.putObject({Bucket:'evidence',Key:item.sha256,Body:item.bytes});raw.push({path:item.path,sha256:item.sha256,sourceType:item.sourceType??sourceType,objectKey:item.sha256,size:item.bytes.length,...(item.requestKey?{requestKey:item.requestKey}:{}),...(item.artifactFilePath?{artifactFilePath:item.artifactFilePath}:{}),...(item.plaintextAuthentication?{plaintextAuthentication:true}:{} )});}return raw;
}
export async function hydrateReturn(objects:ObjectStore,item:any){
  if(item.objectKey===undefined)return item;
  requireCondition(item.objectKey===item.sha256&&Number.isSafeInteger(item.size)&&item.size>=0&&item.size<=MAX_SOURCE_BYTES,'SOURCE_HASH_MISMATCH','Worker pointer does not bind the original SHA and size');let bytes:Buffer;try{bytes=await objects.getObject({Bucket:'evidence',Key:item.objectKey});}catch{throw new Error('Worker original object is unavailable');}
  requireCondition(bytes.length===item.size&&sha256(bytes)===item.sha256,'SOURCE_HASH_MISMATCH','Worker pointed bytes differ');return {...item,contentBase64:bytes.toString('base64')};
}
