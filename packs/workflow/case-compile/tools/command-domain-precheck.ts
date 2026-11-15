// Offline disclosure report. This entry point never creates a network/device reader.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { commandDomainPrecheck, type PrecheckInputs } from '../functions/command-domain-precheck.ts';
import { isRecord } from '../functions/text.ts';
import { resolveCwdRoots, resolveExistingFileInsideCwd, resolveInsideCwd } from './workspace-path.ts';

const USAGE = "node '<技能目录>/tools/command-domain-precheck.ts' --input '<冻结资料JSON>' --out '<报告JSON>'";
export async function main(argv: string[], out: (line: string) => void = console.log, cwdPath?: string): Promise<number> {
  try {
    const options = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!['--input', '--out'].includes(key) || !argv[i + 1] || options.has(key)) throw new Error('参数无效');
      options.set(key, argv[i + 1]);
    }
    if (!options.has('--input') || !options.has('--out')) throw new Error('缺少参数');
    const cwd = resolveCwdRoots(cwdPath), input = resolveExistingFileInsideCwd(cwd, options.get('--input')!, '--input');
    const target = resolveInsideCwd(cwd, options.get('--out')!, '--out');
    // Real materials and reports never become repository fixtures by accident.
    let ancestor = realpathSync(dirname(target.canonical));
    while (true) {
      if (existsSync(join(ancestor, '.git'))) throw new Error('报告目录位于 Git 工作树');
      const next = dirname(ancestor); if (next === ancestor) break; ancestor = next;
    }
    const bytes = await readFile(input.canonical), value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || Object.keys(value).some(key => !['root', 'contract', 'profile', 'inventory', 'catalog', 'plan'].includes(key)) || ['root', 'contract', 'profile', 'inventory', 'catalog', 'plan'].some(key => !Object.hasOwn(value, key)) || typeof value.root !== 'string') throw new Error('资料格式无效');
    const report = commandDomainPrecheck(value as unknown as PrecheckInputs);
    const output = Buffer.from(JSON.stringify({ ...report, input_sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
    await writeFile(target.canonical, output, { mode: 0o600, flag: 'wx' });
    out(JSON.stringify({ rows: report.rows.length, queries: report.rows.filter(row => row.query !== null).length, missing: report.gaps.length + report.rows.reduce((n, row) => n + row.gaps.length, 0), sha256: createHash('sha256').update(output).digest('hex') }));
    return 0;
  } catch {
    out(`参数无效或资料不可读：没有生成报告；核对冻结资料、工作目录内的路径和不存在的输出文件。写法：${USAGE}`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
