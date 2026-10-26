// Shared transient-unknown contracts, independent of runs, packs and resources.
import {z} from 'zod';
import {ExitActionSchema,RequestKindSchema,ReasonSchema} from '../generated/vocabulary.ts';
import {IsoTime,UserId} from './common.ts';
import {referenceUriOf} from './reference.ts';

/** One concrete fact the process must obtain; whitespace never describes a missing fact. */
export const MissingFact = z.string().regex(/\S/, 'name the missing fact');
/** A nonblank external account identity supplied by the referenced mapping. */
export const MappedIdentity=z.string().regex(/\S/,'name the mapped external identity').describe('External account identity bound by the referenced mapping');
/** Named request recipients are accounts or mapped external identities, never a role placeholder. */
export const ExitAudience = z.union([
  z.strictObject({hub:z.literal(true)}),
  z.strictObject({user:UserId}),
  z.strictObject({external:z.strictObject({mapping:referenceUriOf('rec'),identity:MappedIdentity})}),
]);
export const UnknownExit = z.strictObject({
  action:ExitActionSchema,
  request_kind:RequestKindSchema.optional(),
  audience:ExitAudience,
  due:IsoTime.describe('Absolute next-execution time or the named request deadline; never inferred when reading history'),
}).superRefine((exit,ctx)=>{
  if(exit.action==='request'){
    if(exit.request_kind===undefined)ctx.addIssue({code:'custom',path:['request_kind'],message:'a request exit names its request kind'});
    if('hub'in exit.audience)ctx.addIssue({code:'custom',path:['audience'],message:'a request names a person, not the Hub'});
  }else{
    if(exit.request_kind!==undefined)ctx.addIssue({code:'custom',path:['request_kind'],message:'only a request exit names a request kind'});
    if(!('hub'in exit.audience))ctx.addIssue({code:'custom',path:['audience'],message:'a non-request action is scheduled by the Hub; human work needs a request'});
  }
}).meta({allOf:[{if:{properties:{action:{const:'request'}},required:['action']},then:{properties:{request_kind:{},audience:{type:'object',not:{required:['hub'],properties:{hub:{}}}}},required:['request_kind']},else:{properties:{audience:{type:'object',properties:{hub:{const:true}},required:['hub']}},not:{required:['request_kind'],properties:{request_kind:{}}}}}]});
export type UnknownExit=z.infer<typeof UnknownExit>;
export const RecoveryGap=z.strictObject({reason:ReasonSchema,missing:MissingFact,exit:UnknownExit});
/** JSON Schema carries the same unknown-boundary condition as the Zod admission refinement. */
export function recoveryCondition(field:string,values:readonly string[],required:readonly string[]):Record<string,unknown>{
  return {allOf:[{if:{properties:{[field]:{enum:[...values]}},required:[field]},then:{properties:Object.fromEntries(required.map(key=>[key,{}])),required:[...required]}}]};
}

