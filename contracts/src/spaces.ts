// Decision 84, phase 2: shared immutable shapes for personal and team knowledge. Legacy product trees keep their schemas.
import { z } from 'zod';
import { EntryKindSchema, KnowledgeEntryStatusSchema, KnowledgeGranteeSchema, KnowledgeGrantActionSchema } from '../generated/vocabulary.ts';
import { IsoTime, Sha256, UserId } from './common.ts';
import { Ground, TreePath } from './reference.ts';
export const SpaceId = z.union([z.literal('team'), UserId]);
export type SpaceId=z.infer<typeof SpaceId>;
export const SpaceEntryOrigin = z.strictObject({space: UserId, root: Sha256, path: TreePath, entry: Sha256});
export const SpaceGround = z.strictObject({ reference: Ground, quotation: z.string().min(1).max(65536) });
export const SpaceEntryContent = z.strictObject({
  kind: EntryKindSchema,
  statement: z.string().min(1).max(262144),
  data: z.record(z.string(), z.unknown()).default({}),
  applicability: z.record(z.string(), z.unknown()).nullable().default(null),
});
export const SpaceEntryInput = SpaceEntryContent.extend({
  path: TreePath.default('/'),
  grounds: z.array(SpaceGround).max(100).default([]),
  replaces: Sha256.optional(),
  expected_version: Sha256.nullable().optional(),
  reason: z.string().min(1).max(1000).default('条目写入'),
});
export type SpaceEntryInput = z.infer<typeof SpaceEntryInput>;
export const SpaceEntryBody = z.strictObject({
  space: SpaceId, entry: Sha256, content: SpaceEntryContent, grounds: z.array(SpaceGround).max(100),
  status: KnowledgeEntryStatusSchema.extract(['verified', 'unverified']),
  by: UserId, at: IsoTime, session: z.string().nullable(), replaces: Sha256.nullable(),
  shared_from: SpaceEntryOrigin.optional(),
});
export type SpaceEntryBody = z.infer<typeof SpaceEntryBody>;
export const SpaceRow = z.strictObject({ path: TreePath, entry: Sha256, record: Sha256, status: KnowledgeEntryStatusSchema });
export const SpaceTreeNode = z.strictObject({ name: z.string(), children: z.array(z.strictObject({ name: z.string().min(1), digest: Sha256 })).max(10000), entries: z.array(Sha256).max(10000) });
export type SpaceRow = z.infer<typeof SpaceRow>;
export const SpaceVersionBody = z.strictObject({
  space: SpaceId, parent: Sha256.nullable(), tree: Sha256,
  sources: z.array(Sha256).max(10000).default([]),
  products: z.array(z.strictObject({ product: z.string(), line: z.string().nullable(), path: TreePath, root: Sha256 })).max(10000).default([]),
  directories: z.array(TreePath).max(10000), entries: z.array(SpaceRow).max(10000),
  by: UserId.nullable().describe("null only for Hub-maintained team directory snapshots"), at: IsoTime, reason: z.string().min(1).max(1000),
  used_bytes: z.number().int().nonnegative(),
}).refine(row=>row.space==='team'||row.by!==null,'personal versions name their owner');
export type SpaceVersionBody = z.infer<typeof SpaceVersionBody>;
export const SpaceGrantBody = z.strictObject({
  space: UserId, path: TreePath, audience: KnowledgeGranteeSchema, member: UserId.nullable(),
  action: KnowledgeGrantActionSchema, by: UserId, at: IsoTime,
}).refine(v => (v.audience === 'member') === (v.member !== null), 'a member grant names exactly one member');
export type SpaceGrantBody = z.infer<typeof SpaceGrantBody>;
export const SpaceSourceBody = z.strictObject({ space: SpaceId, path: TreePath, sha256: Sha256, artifact: Sha256, size: z.number().int().nonnegative(), by: UserId, at: IsoTime });
export const SpaceQuotaBody = z.strictObject({ space: UserId, bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), by: UserId, at: IsoTime });
export const SpaceLocks = z.strictObject({ team: Sha256, personal: Sha256, owner: UserId });
export const SpaceEntryReceipt = z.strictObject({ space: SpaceId, root: Sha256, entry: Sha256, reference: z.string(), status: KnowledgeEntryStatusSchema });
export const SpaceSearchHit = SpaceEntryReceipt.extend({ path: TreePath, statement: z.string(), kind: EntryKindSchema });
export const schemas = {
  'knowledge-space-node@1': SpaceTreeNode,
  'knowledge-space-entry@1': SpaceEntryBody,
  'knowledge-space-version@1': SpaceVersionBody,
  'knowledge-space-grant@1': SpaceGrantBody,
  'knowledge-space-source@1': SpaceSourceBody,
  'knowledge-space-quota@1': SpaceQuotaBody,
};
