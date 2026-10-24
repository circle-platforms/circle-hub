// W10 data and frozen references. Source bytes and accepted records remain immutable.
import {z} from 'zod';
import {ItemId,UserId,IsoTime} from './common.ts';
import {Ground,referenceUriOf} from './reference.ts';
export const CriterionChange=z.strictObject({item:ItemId,criterion:Ground,assertion:z.string().regex(/\S/u),old:z.string().regex(/\S/u),new:z.string().regex(/\S/u),grounds:z.array(z.strictObject({reference:Ground,quote:z.string().regex(/\S/u)})).min(1)});
export type CriterionChange=z.infer<typeof CriterionChange>;
export const AcceptedCriterionRef=z.strictObject({declaration:referenceUriOf('rec'),review:referenceUriOf('rec'),reviewer:UserId});
export type AcceptedCriterionRef=z.infer<typeof AcceptedCriterionRef>;
export const FrozenCriterion=CriterionChange.extend({...AcceptedCriterionRef.shape,target:Ground});
export type FrozenCriterion=z.infer<typeof FrozenCriterion>;
export const ReplacedCriterion=z.strictObject({criterion:Ground,old:z.string(),new:z.string(),...AcceptedCriterionRef.shape});

/** Derived status, never persisted over the original request or declaration. */
export const CriterionNotice=CriterionChange.extend({request:referenceUriOf('rec'),declaration:referenceUriOf('rec'),audience:UserId,due:IsoTime,answered:z.boolean(),expired:z.boolean(),superseded_by:referenceUriOf('rec').optional(),accepted:z.boolean().optional(),reviewer:UserId.optional(),reason:z.string().optional(),next_action:z.string()});
export type CriterionNotice=z.infer<typeof CriterionNotice>;
