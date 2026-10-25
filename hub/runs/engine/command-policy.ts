import {CommandPolicy} from '../../../contracts/src/product.ts';
import {TreeRootBody} from '../../../contracts/src/knowledge.ts';
import type {RootInfo} from '../../ports.ts';
import type {RecordStore} from '../../records/api.ts';
/** A rule comes only from the exact locked composition, never the currently published product definition. */
export async function commandPolicyForRoot(store:Pick<RecordStore,'get'>,root:RootInfo<RootInfo['build']|null>|null):Promise<CommandPolicy|undefined>{
 if(!root)return undefined;
 const record=await store.get(root.composition);
 if(record){const parsed=record.kind==='tree_root'?TreeRootBody.safeParse(record.body):null;return parsed?.success&&parsed.data.root===root.root?parsed.data.command_policy:undefined;}
 // Nonlocal knowledge backends may attest the same immutable metadata in their RootInfo header.
 const parsed=CommandPolicy.safeParse(root.command_policy);return parsed.success?parsed.data:undefined;
}
