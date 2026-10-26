// Submission (W07): what the client hands back. Stored exactly as received; the Hub computes every terminal state itself.
import { z } from 'zod';
import {ModelIdentitySchema} from '../generated/shared-interfaces.ts';
import {MissingFact,UnknownExit} from './validation.ts';
import { TaskOutputValue } from './contributions.ts';
import type { ItemHandling, Nature } from '../generated/vocabulary.ts';
import { SampleExpectation } from './pack.ts';
import { ItemId, RunId, Versioned } from './common.ts';
import { Ground, referenceUriOf } from './reference.ts';

const reason = z.string().regex(/\S/, 'give the reason in words').describe('why the item is skipped (W07 F[2])');

/** An item the model handled: its slot record, or a carry-over of the predecessor's fragment instead (C08 R[4]). */
export const HandledItem = z
  .strictObject({
    item: ItemId,
    handling: z.literal('handled' satisfies ItemHandling),
    slots: z.record(z.string(), z.unknown()).optional().describe('slot record, validated against the pack slot schema (RunSummary.slots)'),
    context: z.string().optional().describe('digest of the context the model used for this item, so unchanged items can be reused'),
    reuse: referenceUriOf('rec')
      .optional()
      .describe('instead of slots: the Hub record reference start_run offered for this item, to carry the predecessor fragment over; the Hub checks that the item and the cited content are unchanged and reruns the checks'),
  })
  .refine((i) => i.slots === undefined || i.reuse === undefined, { message: 'give either slots or reuse, not both', path: ['reuse'] });

/** An item the model declares skipped; its requirements become incomplete at their declared layers (W07 R[2]). */
export const SkippedItem = z.strictObject({
  item: ItemId,
  handling: z.literal('skipped' satisfies ItemHandling),
  missing:MissingFact.optional().describe('Explicit remaining work; otherwise the Hub derives the unfinished item from its frozen projection'),
  exit:UnknownExit.optional().describe('Optional fully bound intent; the Hub binds the actual request and named recipient'),
  reason,
});

export const ItemSubmission = z.discriminatedUnion('handling', [HandledItem, SkippedItem]);
export type ItemSubmission = z.infer<typeof ItemSubmission>;

const crossItemFields = {
  statement: z.string().min(1),
  code: z.string().min(1).optional(),
  rank: z.string().min(1).optional(),
};
/** `/cross_item/<n>`, n without leading zeros; the Submission refinement requires n to be below the entry's own index. */
const Premise = z.string().regex(/^\/cross_item\/(?:0|[1-9][0-9]*)$/, 'JSON Pointer to an earlier cross_item entry, for example /cross_item/0');

/** A cross-item fact rests on references only. */
export const CrossItemFact = z.strictObject({
  nature: z.literal('fact' satisfies Nature),
  statement: crossItemFields.statement,
  grounds: z.array(Ground).min(1).describe('a fact needs at least one reference; a knowledge entry is cited by its tree address'),
  code: crossItemFields.code,
  rank: crossItemFields.rank,
});

/** A cross-item judgment may also rest on earlier cross-item claims of the same submission. */
export const CrossItemJudgment = z.strictObject({
  nature: z.literal('judgment' satisfies Nature),
  statement: crossItemFields.statement,
  grounds: z.array(Ground),
  premises: z.array(Premise).optional().describe('earlier cross_item entries of this submission that this judgment rests on, for example /cross_item/0'),
  code: crossItemFields.code,
  rank: crossItemFields.rank,
});

/** A claim over several items. */
export const CrossItemSubmission = z.discriminatedUnion('nature', [CrossItemFact, CrossItemJudgment]);
export type CrossItemSubmission = z.infer<typeof CrossItemSubmission>;

/** W04: inline data interpreted by the Hub, never executable code or a client-built subject. */
export const RuntimeCheck = z.strictObject({
  requirement: z.string().min(1),
  interpreter: Versioned,
  table: z.json(),
  samples: z.array(z.strictObject({item: ItemId, expect: z.array(SampleExpectation).min(1)})).max(1000),
});
export type RuntimeCheck = z.infer<typeof RuntimeCheck>;

export {CriterionChange} from './criterion.ts';
import {CriterionChange} from './criterion.ts';

export const Submission = z
  .strictObject({
    run: RunId,
    model: z.string().min(1).describe('model name and exact configuration as the client declares it'),
    model_identity: ModelIdentitySchema.optional().describe('Explicit exact model and family identity; absent on legacy submissions, whose family independence stays unknown'),
    items: z.array(ItemSubmission),
    cross_item: z.array(CrossItemSubmission).optional().describe('claims over several items; optional'),
    notes: z.string().optional(),
    task_outputs: z.array(TaskOutputValue).max(1000).optional(),
    checks: z.array(RuntimeCheck).max(100).optional(),
    criterion_changes:z.array(CriterionChange).max(1000).optional(),
  })
  .superRefine((s, ctx) => {
    const first = new Map<string, number>();
    s.items.forEach((entry, i) => {
      const seen = first.get(entry.item);
      if (seen === undefined) first.set(entry.item, i);
      else ctx.addIssue({ code: 'custom', path: ['items', i, 'item'], message: `item ${entry.item} is already declared at /items/${seen}` });
    });
    const criteria=new Set<string>();
    (s.criterion_changes??[]).forEach((change,index)=>{
      const key=JSON.stringify([change.item,change.criterion]);
      if(criteria.has(key))ctx.addIssue({code:'custom',path:['criterion_changes',index,'criterion'],message:'the same item and criterion is already declared'});
      criteria.add(key);
    });
    (s.cross_item ?? []).forEach((entry, i) => {
      if (entry.nature !== 'judgment') return;
      (entry.premises ?? []).forEach((premise, j) => {
        if (Number(premise.slice('/cross_item/'.length)) >= i) {
          ctx.addIssue({ code: 'custom', path: ['cross_item', i, 'premises', j], message: `a premise points to an earlier entry, below /cross_item/${i}` });
        }
      });
    });
  });
export type Submission = z.infer<typeof Submission>;

/**
 * Body of a submission record whose arguments did not parse as submission@1: the arguments object exactly as received
 * (W07, B05 R[3]). A body that parses is stored as submission@1; both are the raw arguments, never a parsed copy.
 */
export const ReceivedSubmission = z
  .record(z.string(), z.unknown())
  .describe('arguments of a submit_result call exactly as received, stored when they do not parse as submission@1');
export type ReceivedSubmission = z.infer<typeof ReceivedSubmission>;
