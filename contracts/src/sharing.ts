// Decision 84 phase 3: receipts and namespace metadata are append-only; publication checks still own their report payload.
import { z } from 'zod';
import { KnowledgeShareStatusSchema, KnowledgeGranteeSchema, KnowledgeGrantActionSchema, PackKindSchema } from '../generated/vocabulary.ts';
import { IsoTime, Sha256, UserId, PackId, PackVersion } from './common.ts';
import { PackManifest } from './pack.ts';
import { SpaceEntryOrigin } from './spaces.ts';
import {PROTOCOL_CODES} from '../generated/protocol.ts';
import { referenceUriOf, TreePath } from './reference.ts';

export const KnowledgeShareInput = SpaceEntryOrigin.omit({ space: true }).extend({team_path:TreePath.optional()});
/**
 * A single-item share (sync capability share-single-item, owner ruling 1 on issue 141): the entry revision and its own
 * sources arrived in one request without a server copy of the personal space. `team_mark` is the account holder's
 * declaration for that item; `sources` are the raw SHA-256 of the originals that came with it.
 */
export const KnowledgeShareSingleItem = z.strictObject({
  item_id: z.uuid(), object: Sha256, team_mark: z.literal(true), epoch: z.uuid(), operation: Sha256, request: Sha256,
  path: TreePath, sources: z.array(Sha256).max(100),
});
export const KnowledgeShareBody = z.strictObject({
  source: SpaceEntryOrigin.optional(),
  single_item: KnowledgeShareSingleItem.optional(),
  by: UserId, at: IsoTime, session: z.string().nullable(),
  status: KnowledgeShareStatusSchema,
  code: z.string().refine(code=>Object.hasOwn(PROTOCOL_CODES,code),'a registered protocol code').nullable(), message: z.string(),
  team_root: Sha256.nullable(), reference: referenceUriOf('tree').nullable(),
  target_path:TreePath.optional(),
}).refine(row=>(row.source===undefined)!==(row.single_item===undefined),'a share names a personal entry or a single item')
  .refine(row=>row.source===undefined||row.source.space===row.by,'only the personal owner submits sharing')
  .refine(row=>row.status==='merged'?row.code===null&&row.team_root!==null&&row.reference!==null:row.code!==null&&row.team_root===null&&row.reference===null,'merged receipts have a team reference; rejected receipts have a code');
export type KnowledgeShareBody = z.infer<typeof KnowledgeShareBody>;
export const KnowledgeShareReceipt = KnowledgeShareBody.safeExtend({ record: Sha256 });
export type KnowledgeShareReceipt = z.infer<typeof KnowledgeShareReceipt>;

export const PersonalPackVersionBody = z.strictObject({
  space: UserId, pack: PackId, version: PackVersion,
  kind: PackKindSchema.extract(['workflow', 'skill']), digest: Sha256,
  title: z.string(), description: z.string(), manifest: PackManifest,
  publisher: UserId, at: IsoTime, report: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), Sha256).default({}),
});
export type PersonalPackVersionBody = z.infer<typeof PersonalPackVersionBody>;
export const PersonalPackGrantBody = z.strictObject({
  space: UserId, pack: PackId, audience: KnowledgeGranteeSchema, member: UserId.nullable(),
  action: KnowledgeGrantActionSchema, by: UserId, at: IsoTime,
}).refine(row => (row.audience === 'member') === (row.member !== null), 'a member grant names exactly one account');
export type PersonalPackGrantBody = z.infer<typeof PersonalPackGrantBody>;
export const PersonalPackRetirementBody = z.strictObject({space: UserId, pack: PackId, version: PackVersion, digest: Sha256, by: UserId, at: IsoTime});
// `from` (owner ruling 4 on issue 141): a deleted member's private version handed over into the deleting administrator's
// space; `space` is that administrator, `source` the member's version record and `target` the new record.
export const PersonalPackTransferBody = z.strictObject({space: UserId, pack: PackId, version: PackVersion, digest: Sha256, source: Sha256, target: Sha256, by: UserId, at: IsoTime, from: UserId.optional()});

export const schemas = {
  'knowledge-share@1': KnowledgeShareBody,
  'personal-pack-version@1': PersonalPackVersionBody,
  'personal-pack-grant@1': PersonalPackGrantBody,
  'personal-pack-retirement@1': PersonalPackRetirementBody,
  'personal-pack-transfer@1': PersonalPackTransferBody,
};
