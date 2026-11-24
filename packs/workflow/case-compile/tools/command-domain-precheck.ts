import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { commandDomainPrecheck, type PrecheckInputs } from '../functions/command-domain-precheck.ts';
import { isRecord, failCall, formatCallError } from '../functions/text.ts';
import { resolveCwdRoots, resolveExistingFileInsideCwd, resolveInsideCwd } from './workspace-path.ts';

const USAGE = "node '<技能目录>/tools/command-domain-precheck.ts' --input '<冻结资料JSON>' --out '<报告JSON>'";
export async function main(argv: string[], out: (line: string) => void = console.log, cwdPath?: string): Promise<number> {
  try {
    const options = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!['--input', '--out'].includes(key) || !argv[i + 1] || options.has(key)) failCall('invalid_parameters', '选项缺失、重复或不支持', '按合法写法传入 --input 和 --out', { legal_form: USAGE });
      options.set(key, argv[i + 1]);
    }
    if (!options.has('--input') || !options.has('--out')) failCall('invalid_parameters', '缺少 --input 或 --out', '补齐两个必填选项', { legal_form: USAGE });
    const cwd = resolveCwdRoots(cwdPath), input = resolveExistingFileInsideCwd(cwd, options.get('--input')!, '--input');
    const target = resolveInsideCwd(cwd, options.get('--out')!, '--out');
    let existing = dirname(target.canonical);
    while (!existsSync(existing)) existing = dirname(existing);
    let ancestor = realpathSync(existing);
    while (true) {
      if (existsSync(join(ancestor, '.git'))) failCall('permission_denied', '报告目录位于 Git 工作树', '改用 Git 外的私有工作目录后重试', { path: '--out' });
      const next = dirname(ancestor); if (next === ancestor) break; ancestor = next;
    }
    const bytes = await readFile(input.canonical);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failCall('invalid_parameters', '冻结资料不是合法 UTF-8 JSON', '修正资料语法，不修改来源原文冒充有效记录', { path: '--input' }); }
    if (!isRecord(value) || Object.keys(value).some(key => !['root', 'contract', 'profile', 'inventory', 'catalog', 'plan'].includes(key)) || ['root', 'contract', 'profile', 'inventory', 'catalog', 'plan'].some(key => !Object.hasOwn(value, key)) || typeof value.root !== 'string') failCall('invalid_parameters', '冻结资料字段不符合声明', '只提供 root、contract、profile、inventory、catalog、plan 六项完整资料', { path: '--input' });
    const report = commandDomainPrecheck(value as unknown as PrecheckInputs);
    const output = Buffer.from(JSON.stringify({ ...report, input_sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
    await mkdir(dirname(target.canonical), { recursive: true, mode: 0o700 });
    await writeFile(target.canonical, output, { mode: 0o600, flag: 'wx' });
    out(JSON.stringify({ rows: report.rows.length, queries: report.rows.filter(row => row.query !== null).length, missing: report.gaps.length + report.rows.reduce((n, row) => n + row.gaps.length, 0), sha256: createHash('sha256').update(output).digest('hex') }));
    return 0;
  } catch (error) {
    out(formatCallError(error));
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
