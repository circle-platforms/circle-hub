// 只读校验 compile-brief@1 结构化简报的闭合结构、原始条目零篡改、规模上限、未知/假设标注及 brief_sha256 摘要：
//   node '<技能目录>/tools/check-brief.ts' --file '<brief.round-n.json或目录>' [--item '<原始条目JSON>']
import { realpathSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompileBrief } from '../functions/authoring-brief.ts';
import { formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import { parsedPlanFile } from './submit-plans.ts';
import {
  resolveCwdRoots,
  resolveExistingDirInsideCwd,
  resolveExistingFileInsideCwd,
  resolveInsideCwd,
} from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { file: true, item: false };
const USAGE = "node '<技能目录>/tools/check-brief.ts' --file '<brief.round-n.json或目录>' [--item '<原始条目JSON>']";

export interface CheckedBriefFile {
  ok: boolean;
  file: string;
  schema: string | null;
  brief_sha256: string | null;
  round: number | null;
  mode: string | null;
  problems: string[];
}

export interface CheckBriefReport {
  ok: boolean;
  checked: CheckedBriefFile[];
}

export async function checkBriefTarget(options: {
  file: string;
  item?: string;
  cwd?: string;
}): Promise<CheckBriefReport> {
  const cwd = resolveCwdRoots(options.cwd);
  const expectedItem = options.item !== undefined
    ? parsedPlanFile(
        options.item,
        await readFile(resolveExistingFileInsideCwd(cwd, options.item, '--item').canonical),
      )
    : undefined;

  const targetPeek = resolveInsideCwd(cwd, options.file, '--file');
  const st = await lstat(targetPeek.lexical).catch(() => null);
  if (!st) {
    throw new Error(`不存在：找不到 --file 目标 ${options.file}。请核对路径后重试`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`参数无效：--file 目标 ${options.file} 不能是符号链接`);
  }

  const filesToCheck: Array<{ relative: string; canonical: string }> = [];
  if (st.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, options.file, '--file');
    const entries = (await readdir(dir.canonical)).filter((n) => /\.round-\d+\.json$/.test(n)).sort();
    if (entries.length === 0) {
      throw new Error(`不存在：目录 ${dir.relative} 下没有 *.round-<n>.json 结构化简报文件`);
    }
    for (const name of entries) {
      const f = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), '--file');
      filesToCheck.push({ relative: f.relative, canonical: f.canonical });
    }
  } else {
    const f = resolveExistingFileInsideCwd(cwd, options.file, '--file');
    filesToCheck.push({ relative: f.relative, canonical: f.canonical });
  }

  const checked: CheckedBriefFile[] = [];
  for (const target of filesToCheck) {
    const raw = parsedPlanFile(target.relative, await readFile(target.canonical));
    const validation = validateCompileBrief(raw, expectedItem);
    const rec = isRecord(raw) ? raw : null;
    const identity = rec && isRecord(rec.identity) ? rec.identity : null;
    const task = rec && isRecord(rec.task) ? rec.task : null;
    checked.push({
      ok: validation.ok,
      file: target.relative,
      schema: rec && typeof rec.schema === 'string' ? rec.schema : null,
      brief_sha256: rec && typeof rec.brief_sha256 === 'string' ? rec.brief_sha256 : null,
      round: identity && typeof identity.round === 'number' ? identity.round : null,
      mode: task && typeof task.mode === 'string' ? task.mode : null,
      problems: validation.problems,
    });
  }

  return {
    ok: checked.every((c) => c.ok),
    checked,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    const report = await checkBriefTarget({
      file: args.file!,
      ...(args.item !== undefined ? { item: args.item } : {}),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
