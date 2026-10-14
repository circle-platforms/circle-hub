import {ApiError,canonicalJson,requireCondition,sha256} from '../../contracts/src/index.ts';
import {McpGateway,type GatewayProfile} from './case-gateway.ts';
import type {RawReturn} from './readonly-sdk.ts';
export async function gatewayMetadata(handler:string,profile:GatewayProfile,token:string){
 const gateway=new McpGateway(profile,async()=>token);let lease:any,outcome:any;
 try{
  if(handler==='gateway.health')outcome=await gateway.call('lease_status',{});
  else{try{lease=await gateway.call('lease_acquire',{});}catch(error){if(error instanceof ApiError&&error.code==='GATEWAY_REFUSED')throw new ApiError('LEASE_UNAVAILABLE','Gateway topology requires an available lease');throw error;}requireCondition(typeof lease.lease_id==='string'&&Number.isSafeInteger(lease.token),'EVIDENCE_INSUFFICIENT','Gateway topology lease has no fence');outcome=await gateway.call('bed_topology',{lease_id:lease.lease_id,token:lease.token,refresh:false});}
 }finally{if(lease)await gateway.call('lease_release',{lease_id:lease.lease_id,token:lease.token});}
 const bytes=Buffer.from(canonicalJson(outcome)),path=handler==='gateway.health'?'/receipts/lease-status.json':'/receipts/bed-topology.json';
 const raw:RawReturn={bytes,path,sha256:sha256(bytes),etag:null,mediaType:'application/json',sourceType:'gateway-observation'};
 const hosts=[...new Set<string>((outcome.topology?.devices??[]).map((device:any)=>device.name).filter((name:any)=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(name)))].sort();
 return {result:handler==='gateway.health'?{available:true}:{hosts,remoteLeaseReleased:true,observation:'gateway-topology'},raw:[raw],sourceType:'gateway-observation'};
}
