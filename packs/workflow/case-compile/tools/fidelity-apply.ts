// Merges the auditors' verdicts into the case files of a plan directory, as data.fidelity (tools/fidelity.md). A verdict is merged
// only when the brief it answered is still the brief of the plan as it stands, and only when it decides every authored action
// once from the closed set (functions/fidelity.ts); the digest is written by this tool, never typed. In run 19 the model merged
// seventeen verdicts by hand, and one case reached the Hub with the verdict of an earlier plan. Offline.
//   node <skill directory>/tools/fidelity-apply.ts --run <directory>/run.json --plans <plan directory> --briefs <brief directory>
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fidelityProblems } from '../functions/fidelity.ts';
import { isRecord } from '../functions/text.ts';
import { argumentsOf } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { briefFile, planCases, verdictFile } from './fidelity-brief.ts';
import { parsedPlanFile } from './submit-plans.ts';

/** Where a case file keeps its plan data, as functions/subject.ts planDataOf reads it. */
function planData(value: Record<string, unknown>): Record<string, unknown> | null {
  const slots = isRecord(value.slots) ? value.slots : {};
  const plan = Array.isArray(slots.plan) ? slots.plan[0] : slots.plan;
  return isRecord(plan) ? (isRecord(plan.data) ? plan.data : plan) : null;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = argumentsOf(argv, ['run', 'plans', 'briefs']);
    const { cases, skipped } = await planCases(args.run, args.plans);
    const merged: Array<Record<string, unknown>> = [], attention: Array<{ file: string; state: string; message: string }> = [];
    for (const { file, base, value, brief } of cases) {
      const note = (state: string, message: string) => attention.push({ file, state, message });
      let stored: unknown = null;
      try { stored = JSON.parse(await readFile(briefFile(args.briefs, base, brief.brief_sha256), 'utf8')); } catch { /* no brief of this plan yet */ }
      if (!isRecord(stored) || stored.brief_sha256 !== brief.brief_sha256) { note('简报过期', '计划在算简报之后改过，或还没有算简报：重跑 fidelity-brief，审计它列出的简报，再跑本工具'); continue; }
      const verdictPath = verdictFile(args.briefs, base, brief.brief_sha256), verdictName = basename(verdictPath);
      let bytes: Uint8Array;
      try { bytes = await readFile(verdictPath); } catch { note('缺审计结果', `还没有 ${verdictName}：把这份计划的简报交给新开的子代理审计`); continue; }
      let verdict: unknown;
      try { verdict = parsedPlanFile(verdictName, bytes); } catch (error) { note('审计结果不合式', error instanceof Error ? error.message : '不是合法的 JSON'); continue; }
      if (!isRecord(verdict) || Object.keys(verdict).some((key) => key !== 'steps' && key !== 'disclosure')) { note('审计结果不合式', '审计结果恰好写 steps 和 disclosure 两项；让审计子代理按简报里的规则重写这份结果'); continue; }
      const fidelity = { brief_sha256: brief.brief_sha256, steps: verdict.steps, disclosure: verdict.disclosure };
      const judged = fidelityProblems(brief, fidelity);
      const malformed = judged.problems.filter((p) => p.code === 'fidelity_shape');
      if (malformed.length) { note('审计结果不合式', `${malformed.map((p) => p.message).join('；')}；让审计子代理按简报里的规则重写这份结果`); continue; }
      const data = planData(value);
      if (!data) { note('计划不合式', '计划文件里没有 slots.plan，无法写入审计结果'); continue; }
      data.fidelity = fidelity;
      await writeFile(join(args.plans, file), JSON.stringify(value, null, 2) + '\n');
      const count = (verdictName: string) => judged.rows.filter((row) => row.verdict === verdictName).length;
      merged.push({ file, preserved: count('preserved'), changed: count('changed'), unrealized: count('unrealized') });
      // What the Hub will send back to authoring: better known before submitting than after a repair round is spent.
      for (const problem of judged.problems) note('审计判这条计划要改', `${problem.message}；改计划后重跑 fidelity-brief、重新审计这一条`);
    }
    process.stdout.write(JSON.stringify({ ready: attention.length === 0, merged, attention, skipped }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`审计结果没有并入：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
