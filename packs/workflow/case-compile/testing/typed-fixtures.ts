import {catalogFor} from './command-catalog.ts';
// Author declarations for synthetic tests. These helpers never infer a type or authority from submitted prose.
import {createHash} from 'node:crypto';
import {CONTRACT_DOC,PROFILE_DOC,goodData,subjectOf} from '../functions/test-support.ts';
import {entry,signRuntime} from './runtime.ts';
import {contractCanonical,runtimeDigest,stripAdditions} from '../functions/runtime-contract.ts';
import type {CommandIdentity,TypedAddressValue} from '../../../../contracts/generated/shared-interfaces.ts';
const source='src:'+'d'.repeat(64)+'/json@1/p';
export function signTypedRuntime<T extends Record<string,unknown>>(value:T){
 if(value.schema!=='runtime-contract@2')return signRuntime(value);
 const original=stripAdditions(value);if(!original)throw Error('fixture needs an explicit original declaration');
 const digest=runtimeDigest(original);original.contract_sha256=digest;
 return signRuntime({...value,original:{contract_sha256:digest,sha256:createHash('sha256').update(contractCanonical(original)).digest('hex')}});
}
/** Explicit full-literal host authorization for codec tests, never an allow-by-word policy. */
export function hostInput(command:string){const contract=structuredClone(CONTRACT_DOC);contract.effects.effect_1.allowed_literals=[command];return subjectOf({...goodData(),steps:goodData().steps.map((step,i)=>i===1?{...step,args:[command]}:step)},{contractDoc:signTypedRuntime(contract)});}
export function addressIdentity(value:string,kind:'ipv4'|'ipv6'='ipv4'):CommandIdentity{return {tree_root:'d'.repeat(64),path:'/commands/widget/address',signature:source+'/signature',parameters:[{position:0,name:'address',raw:value,type:{name:kind,catalog_type:kind,grammar:'synthetic-address@1',declaration:source+'/types/'+kind},role:{name:'address_target',declaration:source+'/roles/address_target'},parsed:{kind:'address',value:{kind,value} as TypedAddressValue}}]};}
export function addressInput(value:string,options:{kind?:'ipv4'|'ipv6'|'mask'|'ipv4_prefix'|'ipv6_prefix';bedMember?:boolean;source?:string;leases?:unknown[];replacements?:Array<{case:string;bed:string}>}={}){
 const kind=options.kind??'ipv4',contract=structuredClone(CONTRACT_DOC) as Record<string,any>,profile=structuredClone(PROFILE_DOC),data=goodData();
 const catalogType=kind==='ipv4_prefix'||kind==='ipv6_prefix'?'int':kind;
 contract.types.address={declaration:{name:'fixture-address',catalog_type:catalogType,declaration:source+'/types/address',grammar:'synthetic-address@1'},address_kind:kind};
 contract.roles.address_target={source:source+'/roles/address_target',bed_member:options.bedMember??true};
 contract.effects.address={source:source+'/effects/address',roles:['address_target'],budget:1,commands:[],allowed_literals:[],command_roles:[]};
 contract.entries.push({...entry('widget-seat','address',[{name:'value',kind:'positional_only',required:true,default:null}]),typed_authority:{source:source+'/methods/address',parameters:{value:{type:'address',role:'address_target'}},effects:['address']}});
 profile.allowed.push({object:'widget-seat',method:'address',parameters:{value:'address_target'},reviewed:true} as unknown as typeof profile.allowed[number]);
 data.steps[0]={object:'widget-seat',method:'address',args:[value],keywords:{}};data.replacements=options.replacements??[];
 const signed=signTypedRuntime(contract);profile.runtime.contract_sha256=signed.original.contract_sha256;
 const input=subjectOf(data,{contractDoc:signed,profileDoc:profile,leases:options.leases as never});
 input.subject.command_identities=[addressIdentity(options.source??value,kind==='ipv6'?'ipv6':'ipv4')];input.subject.command_catalog=catalogFor([addressIdentity(options.source??value,kind==='ipv6'?'ipv6':'ipv4')]);return input;
}
