import { formatClientCallError } from '../functions/client-cli.ts';
import { CallFailure } from '../functions/text.ts';
import { planStateOf } from '../functions/plan-state.ts';
// The scenario-fidelity briefs of a plan directory (functions/fidelity.ts), for the audit a fresh session makes before the plans
// are submitted (tools/fidelity.md). Length placeholders are expanded first, exactly as tools/submit-plans.ts does before
// sending, so a brief is computed from the bytes the Hub will receive and its digest is the one the Hub recomputes. Offline: it
// reads the plan run's run.json (tools/download-run.ts) for each case's frozen recomposition record; --run names the run directory. The brief directory is kept
// across repairs and nothing in it is ever overwritten or renamed: a brief and its verdict carry the first eight digits of the
// brief's digest in their names, so a changed plan gets a new brief file, only that case is audited again, and the verdict of an
// earlier plan is never merged (in run 19 the model kept five brief directories and tracked the changed digests by hand).
//   node <skill directory>/tools/fidelity-brief.ts --run <run directory> --plans <plan directory> --out <brief directory>
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fidelityBrief, unknownAuthorStepRefs, type FidelityBrief } from '../functions/fidelity.ts';
import { planDataOf } from '../functions/subject.ts';
import { parseCliOptions, isRecord } from '../functions/text.ts';
import { expandPlanFiles, parsedPlanFile } from './submit-plans.ts';
import { resolveRun } from './workspace-path.ts';

export interface PlanCase { file: string; base: string; item: string; value: Record<string, unknown>; brief: FidelityBrief }
/** The brief of a case's plan and the verdict that answers it, named by the brief's digest: another plan, another pair of files. */
export const briefFile = (directory: string, base: string, sha256: string): string => join(directory, `${base}.${sha256.slice(0, 8)}.brief.json`);
export const verdictFile = (directory: string, base: string, sha256: string): string => join(directory, `${base}.${sha256.slice(0, 8)}.verdict.json`);

/** Every case file of a plan directory that has authored actions, with the brief of its plan as it stands now (placeholders expanded). */
export async function planCases(runDirectory: string, plans: string): Promise<{ cases: PlanCase[]; skipped: Array<{ file: string; reason: string }> }> {
  const run = parsedPlanFile('run.json', await readFile(resolveRun(runDirectory).file.lexical));
  if (!isRecord(run) || !Array.isArray(run.items)) throw new CallFailure('invalid_parameters', '--run 请使用脚本编写时下载的运行目录（其中的 run.json 要有原始用例）', "请核对 --run 的冻结运行和 --plans 中的当前计划，再重新生成保真简报");
  const items = new Map(run.items.filter(isRecord).filter((i) => typeof i.id === 'string').map((i) => [i.id as string, i]));
  await expandPlanFiles(plans);
  const cases: PlanCase[] = [], skipped: Array<{ file: string; reason: string }> = [];
  const refused: string[] = [];
  for (const file of (await readdir(plans)).filter((name) => name.endsWith('.json')).sort()) {
    const value = parsedPlanFile(file, await readFile(join(plans, file)));
    if (!isRecord(value) || typeof value.item !== 'string') { skipped.push({ file, reason: '不是用例自动化用例文件（没有 item）' }); continue; }
    const item = items.get(value.item);
    if (!item) { skipped.push({ file, reason: `不属于本次脚本编写的原始用例` }); continue; }
    const eligibility = planStateOf(value, undefined, run);
    if (!eligibility.process) { skipped.push({ file, reason: eligibility.reason! }); continue; }
    const data = planDataOf(value);
    const { fidelity: _judged, ...plan } = isRecord(data) ? data : {};
    const fields = isRecord(item.fields) ? item.fields : {};
    const brief = fidelityBrief(value.item, isRecord(fields.recomposition) ? fields.recomposition.record : undefined, plan);
    if (!brief) { skipped.push({ file, reason: '缺少用例重组时的原始用例步骤，尚未核对自动化用例' }); continue; }
    const unknownRefs = unknownAuthorStepRefs(brief, plan);
    if (unknownRefs.length) refused.push(`${file}（${value.item}）：${unknownRefs.map((r) => `${r.pointer} 写的是 "${r.value}"`).join('；')}；本条作者步骤编号：${brief.author_steps.map((step) => step.n).join('、')}`);
    cases.push({ file, base: file.replace(/\.json$/, ''), item: value.item, value, brief });
  }
  if (refused.length) throw new CallFailure('invalid_parameters', `author_step_refs 要写本条作者步骤的编号（重组记录里作者步骤的 id），这些不是：${refused.join('。')}`, '把每个 author_step_refs 改成它实现的那条作者步骤的编号（如 "a2"）后重跑；说不清对应哪条作者步骤的块不写 author_step_refs');
  return { cases, skipped };
}
const readText = async (path: string): Promise<string | null> => { try { return await readFile(path, 'utf8'); } catch { return null; } };

export async function main(argv: string[]): Promise<number> {
  try {
    const parsedArgs = parseCliOptions(argv, { run: true, plans: true, out: true }, 'node <技能目录>/tools/fidelity-brief.ts --run <运行目录> --plans <plans> --out <out>');
    // Required options are checked by parseCliOptions.
    const args = { run: parsedArgs.run!, plans: parsedArgs.plans!, out: parsedArgs.out! };
    const { cases, skipped } = await planCases(args.run, args.plans);
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const briefs: Array<Record<string, unknown>> = [], toAudit: string[] = [];
    for (const { file, base, item, brief } of cases) {
      const at = briefFile(args.out, base, brief.brief_sha256), verdict = verdictFile(args.out, base, brief.brief_sha256);
      if ((await readText(at)) === null) await writeFile(at, Buffer.from(JSON.stringify(brief, null, 2) + '\n'), { flag: 'wx', mode: 0o600 });
      const audited = (await readText(verdict)) !== null;
      if (!audited) toAudit.push(resolve(at));
      briefs.push({ file, item, brief: resolve(at), verdict: resolve(verdict), brief_sha256: brief.brief_sha256, author_steps: brief.author_steps.length, state: audited ? '未确认' : '未知' });
    }
    process.stdout.write(JSON.stringify({ briefs, to_audit: toAudit, skipped }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
