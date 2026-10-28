// Local gate entry only; no GitHub write path exists until implementation and authenticated native evidence are complete.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublication } from './release-set.ts';

export async function main(args: string[]): Promise<number> {
  if (args.length !== 7 || !['--check', '--publish'].includes(args[0]!)) {
    process.stderr.write('用法：node scripts/release/release.ts <--check|--publish> <资产目录> <仓库> <版本> <提交> <工作流提交> <运行标识>\n');
    return 1;
  }
  const [, directory, repository, version, commit, workflow_commit, run_id] = args as [string, string, string, string, string, string, string];
  try {
    checkPublication(resolve(directory), { repository, version, commit, workflow_commit, run_id });
  } catch {
    process.stderr.write('禁止发布：六目标资产、可信原生证据或平台实现条件未全部满足\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
