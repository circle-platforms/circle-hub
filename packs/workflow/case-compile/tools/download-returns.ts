// What the bed said, on local disk (decision 164): for one verification run, the Hub's job list, the device return the runner
// reads and every row's run log and device sessions the Hub saved, each checked against its digest, so the model copies the
// device's own words into the delivery notes from files instead of from tool answers that may be cut short. It decides nothing.
//   node <skill directory>/tools/download-returns.ts --hub %HUB_URL% --run <verification run> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
// Layout: jobs.json (the Hub's answer), then per job <first 12 of the job id>/device-return.txt and cases/<autoid>/log.txt and
// cases/<autoid>/<session name>, with index.json listing every row's verdict and files (or why a piece is withheld).
import { realpathSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunJobs } from '../functions/delivery.ts';
import { argumentsOf, bearerFrom, get, hubOrigin, HubReplyError, RUN_ID, sha256, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

const SOURCE = /^src:([0-9a-f]{64})$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 写核验运行的编号');
    const origin = hubOrigin(args.hub), bearer = await bearerFrom(readToken);
    const listed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(`${origin}/run-export/${args.run}/jobs`, bearer)));
    const jobs = parseRunJobs(listed, args.run).filter((job) => job.verification_run === args.run);
    if (!jobs.length) throw new Error(`运行 ${args.run} 没有派发过；--run 写派发过的核验运行`);
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [{ name: 'jobs.json', bytes: json(listed) }];
    const withheld: string[] = [];
    // One source read, checked against its digest; a piece the Hub's read rules hold back is named, not fatal.
    const piece = async (reference: string | null | undefined, name: string): Promise<string | null> => {
      const sha = SOURCE.exec(String(reference ?? ''))?.[1];
      if (!sha) return null;
      let bytes: Uint8Array;
      try { bytes = await get(`${origin}/run-export/${args.run}/sources/${sha}`, bearer); }
      catch (error) { if (error instanceof HubReplyError && error.status === 403) { withheld.push(`${name}（${sha.slice(0, 12)}，Hub 的读取规则不给原文）`); return null; } throw error; }
      if (sha256(bytes) !== sha) throw new Error(`${name} 的字节与 Hub 记的摘要不符，什么都没有写入`);
      outputs.push({ name, bytes });
      return name;
    };
    const index: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const folder = job.job.slice(0, 12);
      const deviceReturn = await piece(job.device_return, join(folder, 'device-return.txt'));
      const rows: Array<Record<string, unknown>> = [];
      for (const row of job.rows ?? []) {
        if (!/^[0-9A-Za-z_-]{1,64}$/.test(row.item)) throw new Error(`作业 ${folder} 的条目编号 ${row.item} 不能做目录名`);
        const log = await piece(row.evidence?.log, join(folder, 'cases', row.item, 'log.txt'));
        const sessions: Record<string, string | null> = {};
        for (const [k, [name, reference]] of Object.entries(row.evidence?.sessions ?? {}).entries()) {
          const file = SAFE_NAME.test(name) && name !== 'log.txt' ? name : `session-${k + 1}.txt`;
          sessions[name] = await piece(reference, join(folder, 'cases', row.item, file));
        }
        rows.push({ item: row.item, verdict: row.dynamic_terminal, log, sessions });
      }
      index.push({ job: job.job, plan_run: job.plan_run, workbook_sha256: job.sha256, ended: job.ended, device_return: deviceReturn, rows });
    }
    outputs.push({ name: 'index.json', bytes: json({ schema: 'device-returns@1', run: args.run, jobs: index, withheld }) });
    const present = await readdir(args.out).catch(() => [] as string[]);
    if (present.length) throw new Error(`--out 目录 ${args.out} 里已有文件（${present.slice(0, 3).join('、')}），不覆盖；另选一个新目录`);
    for (const { name } of outputs) await mkdir(join(args.out, name, '..'), { recursive: true, mode: 0o700 });
    for (const { name, bytes } of outputs) await writeNew(join(args.out, name), bytes);
    process.stdout.write(JSON.stringify({ run: args.run, out: resolve(args.out), jobs: jobs.length, files: outputs.length, withheld }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`下载失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
