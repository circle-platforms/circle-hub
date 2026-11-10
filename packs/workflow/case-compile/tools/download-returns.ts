// What the bed said, on local disk (decision 164): for one verification run, the Hub's job list, the device return the runner
// reads and every row's run log and device sessions the Hub saved, each checked against its digest, so the model copies the
// device's own words into the delivery notes from files instead of from tool answers that may be cut short. It decides nothing.
//   node <skill directory>/tools/download-returns.ts --hub %HUB_URL% --run <verification run> --out <directory> [--wait <seconds>] <<'EOF'
//   %HUB_TOKEN%
//   EOF
// With --wait it first waits, for at most that many seconds, until every job of the run has ended: the wait is the program's,
// as in the reference engine, whose run tool returns when the bed has finished. Started as a background command, the client
// tells the model when it exits, so the model neither sleeps nor repeats the submission to read progress (in run 19 it slept
// 3550 seconds in guessed blocks, 13 minutes of them after the last job had ended). It only reads; the Hub runs the job.
// Layout: jobs.json (the Hub's answer), then per job <first 12 of the job id>/device-return.txt and cases/<autoid>/log.txt and
// cases/<autoid>/<session name>, with index.json listing every row's verdict and files (or why a piece is withheld) and, for a
// row with sessions, syntax_rejected: the commands the device answered with a lone caret (session, command, the word under the
// caret, the prompt it was typed at), which is the one cause of failure the reference engine names by program.
import { realpathSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunJobs, syntaxRejections, type SyntaxRejection } from '../functions/delivery.ts';
import { bearerFrom, get, hubOrigin, HubReplyError, RUN_ID, sha256, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

const SOURCE = /^src:([0-9a-f]{64})$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const OPTIONS: Record<string, boolean> = { hub: true, run: true, out: true, wait: false };
function options(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    if (!Object.hasOwn(OPTIONS, key) || !argv[i + 1] || Object.hasOwn(values, key)) throw new Error('参数写法：--hub --run --out 必填，--wait <秒数> 可选，每个只写一次');
    values[key] = argv[i + 1];
  }
  const missing = Object.entries(OPTIONS).filter(([key, required]) => required && !values[key]).map(([key]) => '--' + key);
  if (missing.length) throw new Error(`缺少参数：${missing.join('、')}`);
  return values;
}
/** The longest wait (a background command of the client may run a day), how often the job list is read, and how long a run
 * that shows no job may be waited for: a submission the Hub did not dispatch never gets one, and its answer says why. */
export const WAIT_MAX_SECONDS = 86_400, POLL_MS = 20_000, UNDISPATCHED_MS = 300_000;
export interface Timing { now: () => number; pause: (ms: number) => Promise<void> }
const REAL_TIME: Timing = { now: () => Date.now(), pause: (ms) => new Promise((done) => setTimeout(done, ms)) };

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin, timing: Timing = REAL_TIME): Promise<number> {
  try {
    const args = options(argv);
    if (!RUN_ID.test(args.run)) throw new Error('--run 写核验运行的编号');
    const wait = args.wait === undefined ? 0 : Number(args.wait);
    if (args.wait !== undefined && !(/^[1-9][0-9]{0,4}$/.test(args.wait) && wait <= WAIT_MAX_SECONDS)) throw new Error(`--wait 写最多等多少秒（1 到 ${WAIT_MAX_SECONDS} 的整数）`);
    const taken = await readdir(args.out).catch(() => [] as string[]);
    if (taken.length) throw new Error(`--out 目录 ${args.out} 里已有文件（${taken.slice(0, 3).join('、')}），不覆盖；另选一个新目录`);
    const origin = hubOrigin(args.hub), bearer = await bearerFrom(readToken);
    const fetchJobs = () => get(`${origin}/run-export/${args.run}/jobs`, bearer);
    const parsed = (bytes: Uint8Array) => { const answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return { answer, own: parseRunJobs(answer, args.run).filter((job) => job.verification_run === args.run) }; };
    let { answer: listed, own: jobs } = parsed(await fetchJobs());
    if (wait) {
      const started = timing.now(), deadline = started + wait * 1000;
      process.stderr.write(`等运行 ${args.run} 的作业结束，最多 ${wait} 秒；结束后写出设备返回\n`);
      while (!jobs.length || jobs.some((job) => job.ended === null)) {
        const now = timing.now();
        if (!jobs.length && now - started >= Math.min(UNDISPATCHED_MS, wait * 1000)) throw new Error(`运行 ${args.run} 到现在没有作业：它可能没有派发。原样重交那次提交，读 Hub 答复里的派发说明；什么都没有写入`);
        if (now >= deadline) throw new Error(`等了 ${wait} 秒，运行 ${args.run} 的作业还没有结束；什么都没有写入，用同一命令再等一次`);
        await timing.pause(Math.min(POLL_MS, deadline - now));
        // A read that fails while waiting (the Hub restarting, the network) is tried again at the next turn; a refusal, or an
        // answer that is not a job list, ends the wait.
        let bytes: Uint8Array | null = null;
        try { bytes = await fetchJobs(); } catch (error) { if (error instanceof HubReplyError && error.status < 500) throw error; }
        if (bytes) ({ answer: listed, own: jobs } = parsed(bytes));
      }
    }
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
    let refused = 0;
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
        // The reference engine's one mechanical pre-judgement (functions/delivery.ts syntaxRejections): commands a session shows
        // the device refused to parse. Listed for every row that has sessions, empty when there is none, so absence is read as none.
        const rejected: Array<SyntaxRejection & { session: string }> = [];
        for (const [name, file] of Object.entries(sessions)) {
          const bytes = file === null ? undefined : outputs.find((output) => output.name === file)?.bytes;
          if (bytes) for (const rejection of syntaxRejections(new TextDecoder().decode(bytes))) rejected.push({ session: name, ...rejection });
        }
        refused += rejected.length;
        rows.push({ item: row.item, verdict: row.dynamic_terminal, log, sessions, ...(Object.keys(sessions).length ? { syntax_rejected: rejected } : {}) });
      }
      index.push({ job: job.job, plan_run: job.plan_run, workbook_sha256: job.sha256, ended: job.ended, device_return: deviceReturn, rows });
    }
    outputs.push({ name: 'index.json', bytes: json({ schema: 'device-returns@1', run: args.run, jobs: index, withheld }) });
    for (const { name } of outputs) await mkdir(join(args.out, name, '..'), { recursive: true, mode: 0o700 });
    for (const { name, bytes } of outputs) await writeNew(join(args.out, name), bytes);
    const verdicts: Record<string, number> = {};
    for (const job of jobs) for (const row of job.rows ?? []) verdicts[row.dynamic_terminal] = (verdicts[row.dynamic_terminal] ?? 0) + 1;
    process.stdout.write(JSON.stringify({ run: args.run, out: resolve(args.out), jobs: jobs.length, ended: jobs.map((job) => job.ended ?? 'running'), verdicts, files: outputs.length, withheld, syntax_rejected: refused }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`下载失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
