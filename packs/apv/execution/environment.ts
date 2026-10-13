import {isIP} from 'node:net';
export interface DeviceAttribution {environment?:any;topology?:any}
export const deviceAddress=(value:unknown)=>typeof value==='string'&&isIP(value)?isIP(value)===6?new URL(`http://[${value}]/`).hostname.slice(1,-1):value:null;
export function environmentDevices(attribution:DeviceAttribution={}){
  const count=attribution.environment?.device_count,ordered=(values:any,source:string)=>{if(!Array.isArray(values))return null;const ips=values.map(deviceAddress);if(!ips.length||ips.some(ip=>!ip)||new Set(ips).size!==ips.length||Number.isInteger(count)&&count!==ips.length)return null;return {addresses:ips.map(ip=>[ip!]),source};};
  if(attribution.environment?.conf?.device_ips!==undefined)return ordered(attribution.environment.conf.device_ips,'gateway.env_prepare.conf.device_ips');
  if(attribution.topology?.topology?.applies_to?.device_ssh_ips!==undefined)return ordered(attribution.topology.topology.applies_to.device_ssh_ips,'gateway.bed_topology.applies_to.device_ssh_ips');
  const nodes=attribution.topology?.topology?.devices;if(!Array.isArray(nodes)||!Number.isInteger(count)||count<1)return null;
  const loadBalancers=nodes.filter((item:any)=>item?.type==='负载均衡');if(loadBalancers.length!==count)return null;const addresses:string[][]=Array.from({length:count});
  for(const node of loadBalancers){const name=typeof node.name==='string'?/^APV([0-9]+)$/.exec(node.name):null,index=name?Number(name[1]):-1;if(index<0||index>=count||addresses[index]||!Array.isArray(node.ipv4)||!node.ipv4.length)return null;
    const ips=node.ipv4.map((cidr:any)=>{if(typeof cidr!=='string')return null;const [ip,prefix,...rest]=cidr.split('/');return isIP(ip)===4&&!rest.length&&(prefix===undefined||/^\d+$/.test(prefix)&&Number(prefix)<=32)?ip:null;});if(ips.some((ip:any)=>!ip))return null;addresses[index]=[...new Set<string>(ips)];}
  if(addresses.some(ips=>!ips?.length))return null;return {addresses,source:'gateway.bed_topology.devices'};
}
export function environmentBuild(environment:any,expectedBuild:string){
  const check=environment?.checks?.find((item:any)=>item.check==='device_build'),detail=typeof check?.detail==='string'?/^device reports (.+), gateway bundle is (.+)$/.exec(check.detail):null,observedBuild=typeof environment?.observedBuild==='string'?environment.observedBuild:detail?.[1]??null;
  return {ruleId:'observed-device-build',ruleVersion:'1.0.0',observationSource:'gateway.env_prepare',expectedBuild,observedBuild,passed:environment?.ready===true&&environment?.build_checked===true&&check?.ok===true&&observedBuild===expectedBuild};
}
