// T01 R[6]: a pack may carry skill modules as generated files. Publication compares those files, by manifest, with the
// published skill version the pack names, so a composition the console shows is a checked fact and not the author's word.
// The comparison needs no sandbox: the files are ordinary files of the pack, under its digest.
import { EMBEDDED_SKILLS_DIR, SKILL_MODULES_DIR, type PackManifest } from '../../../contracts/src/pack.ts';
import { problem } from './problems.ts';
import type { PackProblem } from './types.ts';

export interface EmbeddedSkill {
  manifest: PackManifest;
  withdrawn: boolean;
  /** The module names the skill's skill.json declares. */
  modules: readonly string[];
}

const embeddedRoot = (pack: string, module: string): string => `${EMBEDDED_SKILLS_DIR}${pack}/${module}/`;

export async function embeddedProblems(manifest: PackManifest, skill: (pack: string, version: string) => Promise<EmbeddedSkill | null>): Promise<PackProblem[]> {
  const out: PackProblem[] = [];
  const covered = new Set<string>();
  for (const row of manifest.embeds ?? []) {
    const name = `${row.pack}@${row.version}`;
    const root = embeddedRoot(row.pack, row.module);
    for (const file of manifest.files) if (file.path.startsWith(root)) covered.add(file.path);
    const found = await skill(row.pack, row.version);
    if (found === null) { out.push(problem('embeds.skill_missing', 'pack.json', `声明内嵌的通用技能 ${name} 没有发布`, '先发布这个版本的通用技能，再发布这个包', { field: '/embeds' })); continue; }
    if (found.withdrawn) { out.push(problem('embeds.skill_withdrawn', 'pack.json', `声明内嵌的通用技能 ${name} 已下架`, '改用没有下架的版本，重新生成后再发布', { field: '/embeds' })); continue; }
    if (!found.modules.includes(row.module)) { out.push(problem('embeds.module_undeclared', 'pack.json', `通用技能 ${name} 没有声明模块 ${row.module}`, '改正模块名字，或换一个声明了它的版本', { field: '/embeds' })); continue; }
    const source = `${SKILL_MODULES_DIR}${row.module}/`;
    const expected = new Map(found.manifest.files.filter((file) => file.path.startsWith(source)).map((file) => [root + file.path.slice(source.length), file.sha256]));
    const actual = new Map(manifest.files.filter((file) => file.path.startsWith(root)).map((file) => [file.path, file.sha256]));
    for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
      if (expected.get(path) !== actual.get(path)) out.push(problem('embeds.file_differs', path, `${path} 和通用技能 ${name} 的模块 ${row.module} 不一致`, '内嵌文件由 npm run gen:contracts 生成，不手改；重新生成并重签清单后再发布'));
    }
  }
  for (const file of manifest.files) {
    if (file.path.startsWith(EMBEDDED_SKILLS_DIR) && !covered.has(file.path)) out.push(problem('embeds.file_undeclared', file.path, `${file.path} 在内嵌目录里，但 pack.json 的 embeds 没有声明它的模块`, '在 embeds 声明这个模块，或者删除这个文件'));
  }
  return out;
}
