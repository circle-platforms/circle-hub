// Decision 104: the inputs of tools/generate-workbook.ts for one run, fetched from the Hub with the user's own token instead of an
// administrator export: run.json, result.json and submission.json (the run, its latest accepted result and that result's
// submission as stored) and the run's bound contract.json, profile.json and inventory.json as exact bytes, each checked against
// the digest the run bound. The token is read from standard input only, never from the arguments or the environment. The
// command is the one form the skills home of scripts/real/circle-home.ts admits: the installed script by its full path and a
// quoted here-document whose only line is Circle's secret placeholder.
//   node <skill directory>/tools/fetch-run.ts --hub %HUB_URL% --run <run id> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../functions/text.ts';
import { argumentsOf, bearerFrom, get, hubOrigin, RUN_ID, sha256, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

const SLOTS = ['contract', 'profile', 'inventory'] as const;
export interface RunInputs { run: Record<string, unknown>; result: Record<string, unknown>; submission: Record<string, unknown>; originals: Record<typeof SLOTS[number], Uint8Array> }
/** The run, its latest accepted result and submission, and the run's bound contract, profile and inventory, each checked. */
export async function fetchRunInputs(origin: string, bearer: string, run: string): Promise<RunInputs> {
  let exported: unknown;
  try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(`${origin}/run-export/${run}`, bearer))); } catch (error) { if (error instanceof Error && error.message.startsWith('Hub ')) throw error; throw new Error('Hub 返回的原始用例和自动化用例无法读取'); }
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || !isRecord(exported.result) || !isRecord(exported.submission)) throw new Error('Hub 返回的原始用例和自动化用例不完整');
  if (exported.run.run !== run || exported.result.run !== run || exported.submission.run !== run) throw new Error(`Hub 返回的原始用例、自动化用例或核对结果不属于本次脚本编写，文件尚未保存；请核对后重新下载`);
  const sources = Array.isArray(exported.run.sources) ? exported.run.sources : [];
  const originals = {} as RunInputs['originals'];
  for (const slot of SLOTS) {
    const bound = sources.filter((value) => isRecord(value) && value.slot === slot);
    const match = bound.length === 1 && isRecord(bound[0]) ? /^src:([0-9a-f]{64})$/.exec(String(bound[0].reference)) : null;
    if (!match) throw new Error(`缺少唯一的${({ contract: "执行器规则", profile: "测试环境配置", inventory: "测试环境清单" })[slot]}`);
    const bytes = await get(`${origin}/run-export/${run}/sources/${match[1]}`, bearer);
    if (sha256(bytes) !== match[1]) throw new Error(`${({ contract: "执行器规则", profile: "测试环境配置", inventory: "测试环境清单" })[slot]}与脚本编写时的原件不一致，文件尚未保存`);
    originals[slot] = bytes;
  }
  return { run: exported.run, result: exported.result, submission: exported.submission, originals };
}
export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const bearer = await bearerFrom(readToken);
    // Every original is fetched and checked before anything is written, and a failed write removes what this call wrote, so
    // a failure never leaves part of the inputs behind.
    const fetched = await fetchRunInputs(origin, bearer, args.run);
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'run.json', bytes: Buffer.from(JSON.stringify(fetched.run)) },
      { name: 'result.json', bytes: Buffer.from(JSON.stringify(fetched.result)) },
      { name: 'submission.json', bytes: Buffer.from(JSON.stringify(fetched.submission)) },
      ...SLOTS.map((slot) => ({ name: `${slot}.json`, bytes: fetched.originals[slot] })),
    ];
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const taken: string[] = [];
    for (const { name } of outputs) if (await lstat(join(args.out, name)).then(() => true, () => false)) taken.push(name);
    if (taken.length) throw new Error(`--out 目录里已有 ${taken.join('、')}，不覆盖；另选一个新目录重取`);
    const files: Record<string, string> = {}; const written: string[] = [];
    try {
      for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); }
    } catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    process.stdout.write(JSON.stringify({ run: args.run, files }) + '\n'); return 0;
  } catch (error) { process.stderr.write(`脚本编写所需的资料未下载：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
