// Synthetic declared grammar fixtures, never inferred from case prose. Native declaration references are explicit.
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
export const SYNTHETIC_COMMAND_POLICY={schema:'command-policy@1' as const,read_only:['/commands/widget','/commands/show'],inverse_rules:[]};
export function catalogFor(identities:readonly CommandIdentity[],root='f'.repeat(64)){
 const entries=new Map<string,any>();for(const identity of identities){let entry=entries.get(identity.path);if(!entry){entry={words:identity.path.split('/').slice(2).map(decodeURIComponent),reference:'tree:'+root+identity.path,signatures:[]};entries.set(identity.path,entry);}if(!entry.signatures.some((signature:any)=>signature.reference===identity.signature))entry.signatures.push({id:identity.signature,reference:identity.signature,params:identity.parameters.map(parameter=>({name:parameter.name,type:parameter.type.catalog_type,native_type:{name:parameter.type.name,declaration:parameter.type.declaration,grammar:parameter.type.grammar}}))});}
 return {policy:structuredClone(SYNTHETIC_COMMAND_POLICY),root,complete:true,entries:[...entries.values()]};
}
