// B07: shared append-only request shape, including the position of a declaration in its source submission.
import {z} from 'zod';
import {ReferenceUri} from './reference.ts';
import {RequestKindSchema,ExitActionSchema} from '../generated/vocabulary.ts';
import {RunId,UserId,Sha256,IsoTime} from './common.ts';
export const RequestRecord=z.strictObject({answer_action:ExitActionSchema.optional(),run:RunId.optional(),pack_digest:Sha256.optional(),job:Sha256.optional(),sources:z.array(ReferenceUri).optional(),kind:RequestKindSchema,audience:UserId,due:IsoTime,missing:z.string().refine(s=>s.trim().length>0,'must name the concrete fact or next action'),next_action:z.string().refine(s=>s.trim().length>0,'must name the concrete fact or next action'),source:Sha256,code:z.string().min(1),item:z.string().optional(),requirement:z.string().optional(),declaration:z.string().regex(/^\/criterion_changes\/(?:0|[1-9][0-9]*)$/).optional().describe('JSON Pointer into the immutable source submission')}).refine(r=>r.run!==undefined||r.pack_digest!==undefined,'a request binds a run or published pack');
