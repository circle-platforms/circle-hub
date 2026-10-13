import {isIP} from 'node:net';
export interface DeviceAttribution {environment?:any;topology?:any}
export const deviceAddress=(value:unknown)=>typeof value==='string'&&isIP(value)?isIP(value)===6?new URL(`http://[${value}]/`).hostname.slice(1,-1):value:null;
export function environmentDevices(attribution:DeviceAttribution={}){
  const candidates=[{source:'gateway.env_prepare.conf.device_ips',values:attribution.environment?.conf?.device_ips},{source:'gateway.bed_topology.applies_to.device_ssh_ips',values:attribution.topology?.topology?.applies_to?.device_ssh_ips}],present=candidates.filter(item=>item.values!==undefined);
  if(!present.length)return null;const maps=present.map(item=>({...item,values:Array.isArray(item.values)?item.values.map(deviceAddress):[]}));
  if(maps.some(item=>!item.values.length||item.values.some((value:any)=>!value)||new Set(item.values).size!==item.values.length))return null;
  const first=maps[0],count=attribution.environment?.device_count;if(Number.isInteger(count)&&count!==first.values.length||maps.some(item=>JSON.stringify(item.values)!==JSON.stringify(first.values)))return null;
  return {ips:first.values as string[],source:first.source};
}
export function environmentBuild(environment:any,expectedBuild:string){
  const check=environment?.checks?.find((item:any)=>item.check==='device_build'),detail=typeof check?.detail==='string'?/^device reports (.+), gateway bundle is (.+)$/.exec(check.detail):null,observedBuild=typeof environment?.observedBuild==='string'?environment.observedBuild:detail?.[1]??null;
  return {ruleId:'observed-device-build',ruleVersion:'1.0.0',observationSource:'gateway.env_prepare',expectedBuild,observedBuild,passed:environment?.ready===true&&environment?.build_checked===true&&check?.ok===true&&observedBuild===expectedBuild};
}
