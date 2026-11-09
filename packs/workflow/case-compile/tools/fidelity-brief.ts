// The scenario-fidelity brief of every case file of a plan directory (functions/fidelity.ts), for the audit that a fresh
// session makes before the plans are submitted (tools/fidelity.md). It expands the length placeholders first, exactly as
// tools/submit-plans.ts does before sending, so the brief is computed from the bytes the Hub will receive and its digest is the
// one the Hub recomputes. Offline: it reads the plan run's run.json (tools/download-run.ts) for each case's frozen
// recomposition record and writes <out>/<case file>.brief.json without overwriting anything.
//   node <skill directory>/tools/fidelity-brief.ts --run <directory>/run.json --plans <plan directory> --out <new directory>
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fidelityBrief } from '../functions/fidelity.ts';
import { planDataOf } from '../functions/subject.ts';
import { isRecord } from '../functions/text.ts';
import { argumentsOf, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { expandPlanFiles, parsedPlanFile } from './submit-plans.ts';

export async function main(argv: string[]): Promise<number> {
  try {
    const args = argumentsOf(argv, ['run', 'plans', 'out']);
    const run = parsedPlanFile('run.json', await readFile(args.run));
    if (!isRecord(run) || !Array.isArray(run.items)) throw new Error('--run 写 download-run 下载的 run.json（计划运行）');
    const items = new Map(run.items.filter(isRecord).filter((i) => typeof i.id === 'string').map((i) => [i.id as string, i]));
    const entries = await readdir(args.out).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    if (entries.length) throw new Error(`--out 目录里已有文件，不覆盖；另选一个新目录`);
    await expandPlanFiles(args.plans);
    const names = (await readdir(args.plans)).filter((name) => name.endsWith('.json')).sort();
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const briefs: Array<{ file: string; item: string; brief: string; brief_sha256: string; author_steps: number }> = [], skipped: Array<{ file: string; reason: string }> = [];
    for (const name of names) {
      const value = parsedPlanFile(name, await readFile(join(args.plans, name)));
      if (!isRecord(value) || typeof value.item !== 'string') { skipped.push({ file: name, reason: '不是用例计划文件（没有 item）' }); continue; }
      const item = items.get(value.item);
      if (!item) { skipped.push({ file: name, reason: `运行里没有条目 ${value.item}` }); continue; }
      const data = planDataOf(value);
      const { fidelity: _judged, ...plan } = isRecord(data) ? data : {};
      const fields = isRecord(item.fields) ? item.fields : {};
      const frozen = isRecord(fields.recomposition) ? fields.recomposition.record : undefined;
      const brief = fidelityBrief(value.item, frozen, plan);
      if (!brief) { skipped.push({ file: name, reason: '没有重组记录里的作者动作原句，不用审计' }); continue; }
      const out = join(args.out, name.replace(/\.json$/, '.brief.json'));
      await writeNew(out, Buffer.from(JSON.stringify(brief, null, 2) + '\n'));
      briefs.push({ file: name, item: value.item, brief: resolve(out), brief_sha256: brief.brief_sha256, author_steps: brief.author_steps.length });
    }
    process.stdout.write(JSON.stringify({ briefs, skipped }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`简报没有算出：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
