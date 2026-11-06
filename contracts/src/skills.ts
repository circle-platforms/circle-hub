// Platform identities for independently installed skill dependencies.
import {z} from 'zod';
import {PackId,PackVersion,Sha256,UserId} from './common.ts';
export const SkillDependency=z.strictObject({pack:PackId,space:UserId.optional(),version:PackVersion.optional()});
export type SkillDependency=z.infer<typeof SkillDependency>;
export const SkillLock=z.strictObject({pack:PackId,space:UserId.optional(),version:PackVersion,digest:Sha256});
export type SkillLock=z.infer<typeof SkillLock>;
export const SkillDependencies=z.array(SkillDependency).max(64).refine(rows=>new Set(rows.map(row=>(row.space??'team')+'/'+row.pack)).size===rows.length,'skill dependencies name each pack once');
export const SkillLocks=z.array(SkillLock).max(64).refine(rows=>new Set(rows.map(row=>(row.space??'team')+'/'+row.pack)).size===rows.length,'skill locks name each pack once');
/** T01 F[13]: the name of a module of a skill pack, the folder functions/modules/<id>/ of that pack. */
export const SkillModuleId=z.string().regex(/^[a-z][a-z0-9-]{0,62}$/,'a module name is lower-case letters, digits and hyphens');
/** T01 F[14]: one module a pack carries as generated files, and the exact skill version they were generated from. */
export const EmbeddedModule=z.strictObject({pack:PackId,version:PackVersion,module:SkillModuleId});
export type EmbeddedModule=z.infer<typeof EmbeddedModule>;
export const EmbeddedModules=z.array(EmbeddedModule).max(64).refine(rows=>new Set(rows.map(row=>row.pack+'/'+row.module)).size===rows.length,'embeds name each module of a skill once');
export const SKILL_MODULES_DIR='functions/modules/';
export const EMBEDDED_SKILLS_DIR='functions/generated/skills/';
