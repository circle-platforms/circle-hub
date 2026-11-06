// A whole mind map's plans do not fit in one model message: five cases took 27 KB of tool arguments and a model's output stops
// near 32k tokens. The model writes one file per case and this tool sends them as the one complete submission a run takes, so a
// repaired case is rewritten alone and several writers can each own their files. It decides nothing: every file reaches the Hub
// as written and all checks stay there. The token comes from standard input, as tools/fetch-run.ts reads it.
//   node <skill directory>/tools/submit-plans.ts --hub %HUB_URL% --run <run id> --model <model> --plans <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../functions/text.ts';
import { bearerFrom, tokenFromStdin } from './fetch-run.ts';
import { argumentsOf, jsonBytes, readBytes, writeNew } from './files.ts';

const TIMEOUT_MS = 300_000;
const SHOWN_CHARS = 12_000;

/** The case files of a directory in name order; one file is one item of the submission, exactly as written. */
export async function planItems(directory: string): Promise<Array<{ [key: string]: unknown }>> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); } catch { throw new Error(`读不到 --plans 目录 ${directory}`); }
  if (!names.length) throw new Error(`--plans 目录 ${directory} 里没有 .json 文件`);
  const items: Array<{ [key: string]: unknown }> = [], seen = new Map<string, string>();
  for (const name of names) {
    const value = jsonBytes(await readBytes(join(directory, name), 'plans'), 'plans');
    if (!isRecord(value) || typeof value.item !== 'string' || !value.item || typeof value.handling !== 'string') throw new Error(`${name} 不是一个条目；写 {"item":"<编号>","handling":"handled","slots":{"plan":[…]}}`);
    const earlier = seen.get(value.item);
    if (earlier !== undefined) throw new Error(`${earlier} 和 ${name} 是同一个条目 ${value.item}；每个条目只留一个文件`);
    seen.set(value.item, name);
    items.push(value);
  }
  return items;
}

async function call(origin: string, bearer: string, submission: unknown): Promise<{ text: string; failed: boolean }> {
  let reply: Response; let body: string;
  try {
    reply = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_result', arguments: submission } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await reply.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`Hub ${TIMEOUT_MS / 1000} 秒内没有答复；核验可能还在进行，读运行记录确认后再决定是否重交`);
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code ?? error.message : '未知原因';
    throw new Error(`Hub 不可达（${String(cause).slice(0, 120)}）；提交没有发出，核对 --hub 和网络后重交`);
  }
  if (!reply.ok) throw new Error(`Hub 答复 ${reply.status}：${body.trim().slice(0, 300)}`);
  let answer: unknown; try { answer = JSON.parse(body); } catch { throw new Error('Hub 的答复不是 JSON'); }
  if (isRecord(answer) && isRecord(answer.error)) throw new Error(`Hub 拒绝了这次调用：${String(answer.error.message).slice(0, 500)}`);
  const result = isRecord(answer) && isRecord(answer.result) ? answer.result : null, content = Array.isArray(result?.content) ? result.content : [];
  const text = content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n');
  if (result === null || !text) throw new Error('Hub 的答复没有文字内容');
  return { text, failed: result.isError === true };
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'plans']);
    if (!/^run_[a-z0-9]+$/.test(args.run)) throw new Error('--run 必须是运行编号');
    let origin: string; try { const url = new URL(args.hub); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(); origin = url.origin; } catch { throw new Error('--hub 必须是 Hub 的 http 或 https 地址'); }
    const items = await planItems(args.plans);
    const bearer = await bearerFrom(readToken);
    const { text, failed } = await call(origin, bearer, { run: args.run, model: args.model, items });
    const path = join(args.plans, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    const clipped = text.length > SHOWN_CHARS;
    process.stdout.write(`${items.length} 个条目已提交\n${text.slice(0, SHOWN_CHARS)}\n${clipped ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，用 read_file 分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(`提交失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
