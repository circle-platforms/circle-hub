// Decision 35 (kb-adoc step two): every name family of the product produces its own document model from the same
// group of files, with its own attribute set. The pack default is the empty set (all unset, like today's markdown
// reading); real attribute names and values are deployment data the integrator collects read-only and writes per
// apv-deployment-conventions. A family without a configured set produces with the default and the record says so —
// never an unknown. Any family's expansion failure fails the whole group: the old root stays.
import { compileAdoc } from './index.ts';
import type { AdocResult, Composition } from './types.ts';

export interface FamilyInput {
  main: string;
  revision: string;
  families: Record<string, { text: string; revision: string; sha256: string }>;
  /** Per name family (the keys of the product's `names`): its attribute set. Absent = the pack default (empty). */
  familyAttributes: Record<string, Record<string, string | boolean>>;
}

export interface FamilyResult {
  composition: Composition;
  model: Extract<AdocResult, { ok: true }>['model'];
  report: Extract<AdocResult, { ok: true }>['report'];
  /** Where this family's attribute set came from. */
  attributes_origin: { configured: boolean; note: string };
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
  if (rawInput === null || typeof rawInput !== 'object') return { ok: false, error: { code: 'apv.adoc.invalid_input', message: '需要主文件、同一 SVN 修订号和完整文件表', next_action: '补齐或修正指出的原始事实，按同一修订号重新取得整组文件后重跑' } };
  const input = rawInput as FamilyInput;
  const unknown = Object.keys(input.familyAttributes ?? {}).filter((key) => !names.includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: { code: 'apv.adoc.family_not_a_name', message: `属性集的键必须是产品的名称族：${unknown.join('、')} 不是`, next_action: '用 product.json names 里的名称族作键，重新给属性集后重跑' } };
  }
  const files = { ...input.families };
  const families: Record<string, FamilyResult> = {};
  for (const name of names) {
    const declared = input.familyAttributes?.[name];
    const configured = declared !== undefined;
    const attributes = configured ? declared : {};
    const out = await compileAdoc({ main: input.main, revision: input.revision, files, attributes });
    if (!out.ok) {
      // The old root stays: a group failure never replaces it with a partial result (K4 item 7).
      // The per-group failure text (including that the old root stays) is already the compile's next_action.
      return { ok: false, error: { code: out.error.code, message: `名称族 ${name}：${out.error.message}`, next_action: out.error.next_action } };
    }
    families[name] = {
      composition: out.composition,
      model: out.model,
      report: out.report,
      attributes_origin: configured
        ? { configured: true, note: '包的默认值之外的属性集（部署数据；名称与取值由集成者从源里只读整理）' }
        : { configured: false, note: '这一族的属性集没有配置，按包的默认值（全不设）产出；下一步是管理员配上以后重新同步' },
    };
  }
  return { ok: true, families };
}

export default compileFamilies;
