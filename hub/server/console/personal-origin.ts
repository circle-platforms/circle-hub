// Source-directory names remain personal after sharing; the team's copy and safe receipt facts remain visible.
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {parseReference} from '../../refs/api.ts';
import type {PageContext} from './pages.ts';
import {code} from './html.ts';
const flags=new WeakMap<PageContext,Map<string,Promise<boolean>>>();
export function personalOriginCleared(ctx:PageContext,root:string):Promise<boolean>{
 let cache=flags.get(ctx);if(!cache){cache=new Map();flags.set(ctx,cache);}
 let found=cache.get(root);if(!found){found=ctx.deps.records.personalPayloads?.cleared(root)??Promise.resolve(false);cache.set(root,found);}return found;
}
export const clearedPersonalFolder=()=>uiLabelOf('sync_field','cleared_personal_folder');
export async function originReference(ctx:PageContext,reference:string){
 const parsed=parseReference(reference);
 return parsed.scheme==='tree'&&await personalOriginCleared(ctx,parsed.root)?clearedPersonalFolder():code(reference);
}
