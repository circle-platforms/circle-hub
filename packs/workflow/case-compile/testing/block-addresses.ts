// Synthetic typed endpoints; names never determine roles or bed membership.
import {fixture,positiveBlocks} from './blocks.ts';
import {signTypedRuntime} from './typed-fixtures.ts';
import {parseRuntimeContract} from '../functions/runtime-contract.ts';
import {parseProfile} from '../functions/profile.ts';
import {parseManifest} from '../functions/manifest.ts';
import type {PlanSlots} from '../functions/slots.ts';
export function addressFixture(){
 const f=fixture(),doc=structuredClone(f.contractDoc) as Record<string,any>,profile=structuredClone(f.profileDoc) as Record<string,any>;
 const source='src:'+'d'.repeat(64)+'/json@1/p';
 doc.types.endpoint={declaration:{name:'synthetic-ipv4',catalog_type:'ipv4',grammar:'synthetic-address@1',declaration:source+'/types/endpoint'},address_kind:'ipv4'};
 doc.roles.bed_endpoint={source:source+'/roles/bed_endpoint',bed_member:true};
 doc.roles.external_endpoint={source:source+'/roles/external_endpoint',bed_member:false};
 for(const method of doc.entries)if(method.e==='ORBIT_0'&&(method.f==='command'||method.f==='restore_checked')){
  method.signature.parameters.push({name:'endpoint',kind:'keyword_only',required:true,default:null});
  method.signature.required.push('endpoint');
  method.typed_authority.parameters.endpoint={type:'endpoint',role:'bed_endpoint'};
 }
 for(const effect of [doc.effects.command,doc.effects.restore])effect.roles.push('bed_endpoint');
 for(const call of profile.allowed)if(call.object==='ORBIT_0'&&(call.method==='command'||call.method==='restore_checked'))call.parameters.endpoint='bed_endpoint';
 doc.runtime.block_model.output_methods.push({object:'ORBIT_0',method:'restore_checked',output:'raw_text'});
 const signed=signTypedRuntime(doc);profile.runtime.contract_sha256=signed.original.contract_sha256;
 const parsed=parseRuntimeContract(signed),beds=parseManifest(f.inventory);if(!parsed.ok||!beds.ok)throw Error('invalid synthetic address contract');
 const p=parseProfile(profile,parsed.contract,beds.beds);if(!p.ok)throw Error(JSON.stringify(p.problems));
 const data=(kind:keyof ReturnType<typeof positiveBlocks>='OBSERVE_ASSERT',value='192.0.2.10',index?:number):PlanSlots=>{
  const plan=positiveBlocks()[kind];for(const block of plan.blocks)if(block.call?.object==='ORBIT_0')block.call.keywords.endpoint='192.0.2.10';
  const target=index??(kind==='RESTORE_FROM'?3:0);plan.blocks[target].call.keywords.endpoint=value;return plan;
 };
 const subject=(plan:PlanSlots,extra:Record<string,unknown>={})=>f.subject(plan,{contract:signed,profile,...extra});
 return {...f,contractDoc:signed,profileDoc:profile,contract:parsed.contract,profile:p.profile,data,subject};
}
