// The scenario-fidelity briefs of a plan directory (functions/fidelity.ts), for the audit a fresh session makes before the plans
// are submitted (tools/fidelity.md). Length placeholders are expanded first, exactly as tools/submit-plans.ts does before
// sending, so a brief is computed from the bytes the Hub will receive and its digest is the one the Hub recomputes. Offline: it
// reads the plan run's run.json (tools/download-run.ts) for each case's frozen recomposition record. The brief directory is kept
// across repairs and nothing in it is ever overwritten or renamed: a brief and its verdict carry the first eight digits of the
// brief's digest in their names, so a changed plan gets a new brief file, only that case is audited again, and the verdict of an
// earlier plan is never merged (in run 19 the model kept five brief directories and tracked the changed digests by hand).
//   node <skill directory>/tools/fidelity-brief.ts --run <directory>/run.json --plans <plan directory> --out <brief directory>
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fidelityBrief, type FidelityBrief } from '../functions/fidelity.ts';
import { planDataOf } from '../functions/subject.ts';
import { isRecord } from '../functions/text.ts';
import { argumentsOf, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { expandPlanFiles, parsedPlanFile } from './submit-plans.ts';

export interface PlanCase { file: string; base: string; item: string; value: Record<string, unknown>; brief: FidelityBrief }
/** The brief of a case's plan and the verdict that answers it, named by the brief's digest: another plan, another pair of files. */
export const briefFile = (directory: string, base: string, sha256: string): string => join(directory, `${base}.${sha256.slice(0, 8)}.brief.json`);
export const verdictFile = (directory: string, base: string, sha256: string): string => join(directory, `${base}.${sha256.slice(0, 8)}.verdict.json`);

/** Every case file of a plan directory that has authored actions, with the brief of its plan as it stands now (placeholders expanded). */
export async function planCases(runPath: string, plans: string): Promise<{ cases: PlanCase[]; skipped: Array<{ file: string; reason: string }> }> {
  const run = parsedPlanFile('run.json', await readFile(runPath));
  if (!isRecord(run) || !Array.isArray(run.items)) throw new Error('--run 写 download-run 下载的 run.json（计划运行）');
  const items = new Map(run.items.filter(isRecord).filter((i) => typeof i.id === 'string').map((i) => [i.id as string, i]));
  await expandPlanFiles(plans);
  const cases: PlanCase[] = [], skipped: Array<{ file: string; reason: string }> = [];
  for (const file of (await readdir(plans)).filter((name) => name.endsWith('.json')).sort()) {
    const value = parsedPlanFile(file, await readFile(join(plans, file)));
    if (!isRecord(value) || typeof value.item !== 'string') { skipped.push({ file, reason: '不是用例计划文件（没有 item）' }); continue; }
    const item = items.get(value.item);
    if (!item) { skipped.push({ file, reason: `运行里没有条目 ${value.item}` }); continue; }
    const data = planDataOf(value);
    const { fidelity: _judged, ...plan } = isRecord(data) ? data : {};
    const fields = isRecord(item.fields) ? item.fields : {};
    const brief = fidelityBrief(value.item, isRecord(fields.recomposition) ? fields.recomposition.record : undefined, plan);
    if (!brief) { skipped.push({ file, reason: '没有重组记录里的作者动作原句，不用审计' }); continue; }
    cases.push({ file, base: file.replace(/\.json$/, ''), item: value.item, value, brief });
  }
  return { cases, skipped };
}
const readText = async (path: string): Promise<string | null> => { try { return await readFile(path, 'utf8'); } catch { return null; } };

export async function main(argv: string[]): Promise<number> {
  try {
    const args = argumentsOf(argv, ['run', 'plans', 'out']);
    const { cases, skipped } = await planCases(args.run, args.plans);
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const briefs: Array<Record<string, unknown>> = [], toAudit: string[] = [];
    for (const { file, base, item, brief } of cases) {
      const at = briefFile(args.out, base, brief.brief_sha256), verdict = verdictFile(args.out, base, brief.brief_sha256);
      if ((await readText(at)) === null) await writeNew(at, Buffer.from(JSON.stringify(brief, null, 2) + '\n'));
      const audited = (await readText(verdict)) !== null;
      if (!audited) toAudit.push(resolve(at));
      briefs.push({ file, item, brief: resolve(at), verdict: resolve(verdict), brief_sha256: brief.brief_sha256, author_steps: brief.author_steps.length, state: audited ? '已有这份计划的审计结果' : '需要审计' });
    }
    process.stdout.write(JSON.stringify({ briefs, to_audit: toAudit, skipped }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`简报没有算出：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
