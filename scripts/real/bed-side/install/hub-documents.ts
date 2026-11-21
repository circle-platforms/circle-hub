// After a bed-side runtime is installed, the rule it exported says which bytes run, so the Hub's two rule documents change: the
// rule and its original-format rule. The deployment profile holds no copy of an identity (decision 184) and stays as it is
// served; the identity a workbook carries is the rule's interface identity, which a repair that changes no declaration leaves
// as it was, so workbooks compiled before it stay valid. This takes the two rule files the install exported and the documents
// the Hub serves now, says what changed, and makes the comparisons a run makes before anyone publishes. A profile published
// before decision 184 still carries the retired digest field: it is written again without it, once. It reads and writes local
// files only: no Hub, no gateway, no device.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../../../../packs/workflow/case-compile/functions/manifest.ts';
import { parseProfile, templateProblem } from '../../../../packs/workflow/case-compile/functions/profile.ts';
import { parseRuntimeContract } from '../../../../packs/workflow/case-compile/functions/runtime-contract.ts';

export const DOCUMENTS = { contract: 'runner-contract.json', original: 'runner-contract-cell-original.json', profile: 'runtime-profile.json' } as const;
export interface HubDocumentsInput { contract: Buffer; original: Buffer; publishedContract: Buffer; profile: Buffer; inventory: Buffer }
export interface HubDocumentsReport {
  /** The digest of the Hub's rule document. */
  rule: { from: string; to: string };
  /** What a workbook carries and the gateway pins. */
  workbook_identity: { from: string; to: string };
  /** Which bytes run: the whole digest of the original-format rule. */
  build_identity: { from: string; to: string };
  sources_changed: string[];
  /** True when workbooks compiled against the served rule are still accepted after the install. */
  compiled_workbooks_stay_valid: boolean;
  /** 'unchanged': publish the two rule documents only. 'retired_field_removed': the profile is written too, without the field. */
  profile: 'unchanged' | 'retired_field_removed';
  documents: Record<string, string>;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const record = (text: string, what: string): Record<string, any> => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${what}不是 JSON`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what}不是 JSON 对象`);
  return value as Record<string, any>;
};
const problemsOf = (problems: unknown): string => JSON.stringify(problems).slice(0, 600);

export function hubDocuments(input: HubDocumentsInput): { files: Record<string, Buffer>; report: HubDocumentsReport } {
  const next = record(input.contract.toString('utf8'), '新的执行器规则'), published = record(input.publishedContract.toString('utf8'), 'Hub 现在提供的执行器规则');
  const original = record(input.original.toString('utf8'), '新的原格式规则');
  const rule = parseRuntimeContract(next), before = parseRuntimeContract(published);
  if (!rule.ok) throw new Error('新的执行器规则没有通过核对：' + problemsOf(rule.problems));
  if (!before.ok) throw new Error('Hub 现在提供的执行器规则没有通过核对：' + problemsOf(before.problems));
  if (next.original?.sha256 !== sha256(input.original) || next.original?.contract_sha256 !== original.contract_sha256) throw new Error('原格式规则文件不是新规则声明的那一份（字节摘要或规范身份不同）');
  const beds = parseManifest(record(input.inventory.toString('utf8'), '测试环境清单'));
  if (!beds.ok) throw new Error('测试环境清单没有通过核对');

  const changed: string[] = [];
  for (const [path, digest] of Object.entries(next.source_hashes ?? {})) if (published.source_hashes?.[path] !== digest) changed.push(path);
  for (const path of Object.keys(published.source_hashes ?? {})) if (!Object.hasOwn(next.source_hashes ?? {}, path)) changed.push(path);

  // The profile as served, or once without the field decision 184 retired. The document keeps its own layout.
  const servedText = input.profile.toString('utf8');
  const profile = record(servedText, 'Hub 现在提供的运行环境配置');
  const retired = profile.runtime !== null && typeof profile.runtime === 'object' && Object.hasOwn(profile.runtime, 'contract_sha256');
  if (retired) delete profile.runtime.contract_sha256;
  const written = !retired ? servedText : /\n/.test(servedText.trim()) ? JSON.stringify(profile, null, 2) + (servedText.endsWith('\n') ? '\n' : '') : JSON.stringify(profile);

  // The comparisons the start of a run makes (functions/project.ts), on the profile as it will be served.
  const parsed = parseProfile(record(written, '运行环境配置'), rule.contract, beds.beds);
  if (!parsed.ok) throw new Error('运行环境配置配不上新的执行器规则：' + problemsOf(parsed.problems));
  const template = templateProblem(record(written, '运行环境配置'));
  if (template !== null) throw new Error('运行环境配置配不上新的执行器规则：' + template.message);

  const files: Record<string, Buffer> = { [DOCUMENTS.contract]: input.contract, [DOCUMENTS.original]: input.original, ...(retired ? { [DOCUMENTS.profile]: Buffer.from(written, 'utf8') } : {}) };
  return {
    files,
    report: {
      rule: { from: String(published.contract_sha256), to: String(next.contract_sha256) },
      workbook_identity: { from: before.contract.pinned.identity, to: rule.contract.pinned.identity },
      build_identity: { from: before.contract.pinned.build, to: rule.contract.pinned.build },
      sources_changed: changed.sort(),
      compiled_workbooks_stay_valid: before.contract.pinned.identity === rule.contract.pinned.identity && before.contract.runtimeVersion === rule.contract.runtimeVersion,
      profile: retired ? 'retired_field_removed' : 'unchanged',
      documents: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
    },
  };
}

function main(): void {
  const { values } = parseArgs({ options: { contract: { type: 'string' }, original: { type: 'string' }, 'published-contract': { type: 'string' }, profile: { type: 'string' }, inventory: { type: 'string' }, out: { type: 'string' } } });
  const need = ['contract', 'original', 'published-contract', 'profile', 'inventory', 'out'] as const;
  if (need.some((name) => !values[name])) throw new Error('用法：--contract <新的 Hub 规则> --original <新的原格式规则> --published-contract <Hub 现在提供的规则> --profile <Hub 现在提供的配置> --inventory <测试环境清单> --out <新目录>');
  const out = resolve(values.out!);
  if (existsSync(out)) throw new Error('输出目录已存在；每次生成用新目录');
  const made = hubDocuments({ contract: readFileSync(values.contract!), original: readFileSync(values.original!), publishedContract: readFileSync(values['published-contract']!), profile: readFileSync(values.profile!), inventory: readFileSync(values.inventory!) });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(made.files)) writeFileSync(join(out, name), bytes, { mode: 0o600 });
  console.log(JSON.stringify(made.report, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
