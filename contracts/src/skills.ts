// Platform identities for independently installed skill dependencies.
import {z} from 'zod';
import {PackId,PackVersion,Sha256,UserId} from './common.ts';
export const SkillDependency=z.strictObject({pack:PackId,space:UserId.optional(),version:PackVersion.optional()});
export type SkillDependency=z.infer<typeof SkillDependency>;
export const SkillLock=z.strictObject({pack:PackId,space:UserId.optional(),version:PackVersion,digest:Sha256});
export type SkillLock=z.infer<typeof SkillLock>;
export const SkillDependencies=z.array(SkillDependency).max(64).refine(rows=>new Set(rows.map(row=>(row.space??'team')+'/'+row.pack)).size===rows.length,'skill dependencies name each pack once');
export const SkillLocks=z.array(SkillLock).max(64).refine(rows=>new Set(rows.map(row=>(row.space??'team')+'/'+row.pack)).size===rows.length,'skill locks name each pack once');
