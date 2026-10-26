// Decision 35 (kb-adoc step two): every name family of the product produces its own document model from the same
// group of files, with its own attribute set. The pack default is the empty set (all unset, like today's markdown
// reading); real attribute names and values are deployment data the integrator collects read-only and writes per
// famx-deployment-conventions. Any family's expansion failure fails the whole group: the old root stays.
//
// Where an attribute set came from is not this producer's to say. It records what it was given — whether the parameter
// named this family, and the set it ran with — and nothing else: an explicit empty set is declared, and a synthetic set
// is as declared as a real one. The origin belongs to the Hub composition's `variables` list; the producer receives
// only resolved parameters and does not invent provenance. Missing deployment variables refuse a real sync before reads.
import { compileAdoc } from './index.ts';
import type { AdocResult, Composition, ExpandedModel, Report } from './types.ts';

export interface FamilyInput {
  main: string;
  revision: string;
  /** SVN directory of this book. The composition records it with the revision and each file digest. */
  directory?: string;
  families: Record<string, { text: string; revision: string; sha256: string }>;
  /** Per name family (the keys of the product's `names`): its attribute set. Absent = the pack default (empty). */
  familyAttributes: Record<string, Record<string, string | boolean>>;
}

/** The attribute set one family ran with, as the parameter gave it, and what the producer knows about it. */
export interface FamilyAttributes {
  /** True when the parameter named this family — whatever it declared, an explicit empty set included. */
  declared: boolean;
  /** The set this family was expanded with: the declared one, or the pack default (empty) when no key named it. */
  values: Record<string, string | boolean>;
  /** What the producer can say about the set: which set it used, and that the origin is the Hub's record, not its own. */
  note: string;
}

export interface FamilyResult {
  composition: Composition;
  model: ExpandedModel;
  report: Report;
  attributes: FamilyAttributes;
}

export type FamiliesResult =
  | { ok: true; families: Record<string, FamilyResult> }
  | { ok: false; error: { code: string; message: string; next_action: string } };

/** The manual name of one family: `<manual>-<family lower-cased>` (the spelling is documented in the README). */
export function familyManualName(family: string, manual: string): string {
  return `${manual}-${family.toLowerCase()}`;
}

/** Compile one group once per name family. Any failure fails the group; nothing partial is returned. */
export async function compileFamilies(rawInput: unknown, names: readonly string[]): Promise<FamiliesResult> {
  if (rawInput === null || typeof rawInput !== 'object') return { ok: false, error: { code: 'famx.adoc.invalid_input', message: '需要主文件、同一 SVN 修订号和完整文件表', next_action: '补齐或修正指出的原始事实，按同一修订号重新取得整组文件后重跑' } };
  const input = rawInput as FamilyInput;
  const unknown = Object.keys(input.familyAttributes ?? {}).filter((key) => !names.includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: { code: 'famx.adoc.family_not_a_name', message: `属性集的键不在本次 names 编译范围内：${unknown.join('、')}`, next_action: '按 product.json names 选择本次编译范围，只传相应名称族的属性集后重跑；不借用另一族属性' } };
  }
  const files = { ...input.families };
  const families: Record<string, FamilyResult> = {};
  for (const name of names) {
    const declared = input.familyAttributes?.[name];
    const given = declared !== undefined;
    const values = given ? declared : {};
    const out = await compileAdoc({ main: input.main, revision: input.revision, ...(input.directory ? { directory: input.directory } : {}), files, attributes: values });
    if (!out.ok) {
      // The old root stays: a group failure never replaces it with a partial result (K4 item 7).
      // The per-group failure text (including that the old root stays) is already the compile's next_action.
      return { ok: false, error: { code: out.error.code, message: `名称族 ${name}：${out.error.message}`, next_action: out.error.next_action } };
    }
    families[name] = {
      composition: out.composition,
      model: out.model,
      report: out.report,
      attributes: {
        declared: given,
        values,
        note: given
          ? `参数给了这一族的属性集（${Object.keys(values).length} 个属性），已按它展开。这一组属性从哪来由 Hub 的组成记录（variables）写，生产器不自己记来源。`
          : '参数里没有这一族的键，按包的默认值（全不设，与现在的 md 一致）展开。样例和试运行可用此默认值；真实同步缺少变量时由 Hub 在读页前拒绝，来历记在组成记录 variables；生产器不自己记来源，也不记未知。',
      },
    };
  }
  return { ok: true, families };
}

export default compileFamilies;
