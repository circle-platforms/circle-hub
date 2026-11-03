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
import { argumentsOf, writeNew, sha256 } from './files.ts';

const SLOTS = ['contract', 'profile', 'inventory'] as const;
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

async function tokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}
// A failure to reach the Hub is reported as what it is, never as a malformed answer (a submission that never arrived is told apart
// from one whose results could not be read).
async function get(url: string, bearer: string): Promise<Uint8Array> {
  let reply: Response; let bytes: Uint8Array;
  try {
    reply = await fetch(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    bytes = new Uint8Array(await reply.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`Hub ${TIMEOUT_MS / 1000} 秒内没有答复；稍后用同一命令重取`);
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code ?? error.message : '未知原因';
    throw new Error(`Hub 不可达（${String(cause).slice(0, 120)}）；核对 --hub 是 MCP 条目的地址、网络可达后重取`);
  }
  if (!reply.ok) throw new Error(`Hub 答复 ${reply.status}：${new TextDecoder().decode(bytes).trim().slice(0, 300)}`);
  if (bytes.length > MAX_BYTES) throw new Error('Hub 答复超过 16 MiB 上限');
  return bytes;
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!/^run_[a-z0-9]+$/.test(args.run)) throw new Error('--run 必须是运行编号');
    let origin: string; try { const url = new URL(args.hub); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(); origin = url.origin; } catch { throw new Error('--hub 必须是 Hub 的 http 或 https 地址（与 MCP 条目同一台）'); }
    const bearer = await readToken();
    // Circle hands a secret it does not store over as its literal placeholder: that is no token, and it is never sent.
    const placeholder = /^%([A-Z][A-Z0-9_]*)%$/.exec(bearer);
    if (placeholder) throw new Error(`Circle 里没有存密钥 ${placeholder[1]}（标准输入收到的是原样的占位符），什么都没有发出；所有者用 /secrets ${placeholder[1]} 存入 Hub 令牌后重跑`);
    if (!/^[\x21-\x7e]{8,4096}$/.test(bearer)) throw new Error("标准输入里没有令牌；在命令末尾写 <<'EOF'，下一行写 %HUB_TOKEN%，再一行写 EOF，令牌不写进参数");
    let exported: unknown;
    try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(`${origin}/run-export/${args.run}`, bearer))); } catch (error) { if (error instanceof Error && error.message.startsWith('Hub ')) throw error; throw new Error('Hub 的运行导出不是完整的 UTF-8 JSON'); }
    if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || !isRecord(exported.result) || !isRecord(exported.submission)) throw new Error('Hub 的运行导出不合式');
    if (exported.run.run !== args.run || exported.result.run !== args.run || exported.submission.run !== args.run) throw new Error(`Hub 导出的运行、结果或提交不属于 --run 指定的 ${args.run}，什么都没有写入；核对运行号后重取`);
    const sources = Array.isArray(exported.run.sources) ? exported.run.sources : [];
    const wanted = SLOTS.map((slot) => {
      const bound = sources.filter((value) => isRecord(value) && value.slot === slot);
      const match = bound.length === 1 && isRecord(bound[0]) ? /^src:([0-9a-f]{64})$/.exec(String(bound[0].reference)) : null;
      if (!match) throw new Error(`运行没有唯一绑定的 ${slot} 原件`);
      return { slot, sha: match[1] };
    });
    // Every original is fetched and checked before anything is written, and a failed write removes what this call wrote, so
    // a failure never leaves part of the inputs behind.
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'run.json', bytes: Buffer.from(JSON.stringify(exported.run)) },
      { name: 'result.json', bytes: Buffer.from(JSON.stringify(exported.result)) },
      { name: 'submission.json', bytes: Buffer.from(JSON.stringify(exported.submission)) },
    ];
    for (const { slot, sha } of wanted) {
      const bytes = await get(`${origin}/run-export/${args.run}/sources/${sha}`, bearer);
      if (sha256(bytes) !== sha) throw new Error(`${slot} 原件摘要与运行绑定不符，什么都没有写入`);
      outputs.push({ name: `${slot}.json`, bytes });
    }
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const taken: string[] = [];
    for (const { name } of outputs) if (await lstat(join(args.out, name)).then(() => true, () => false)) taken.push(name);
    if (taken.length) throw new Error(`--out 目录里已有 ${taken.join('、')}，不覆盖；另选一个新目录重取`);
    const files: Record<string, string> = {}; const written: string[] = [];
    try {
      for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); }
    } catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    process.stdout.write(JSON.stringify({ run: args.run, files }) + '\n'); return 0;
  } catch (error) { process.stderr.write(`取件失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
