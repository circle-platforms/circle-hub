// A whole mind map's plans do not fit in one model message: five cases took 27 KB of tool arguments and a model's output stops
// near 32k tokens. The model writes one file per case and this tool sends them as the one complete submission a run takes, so a
// repaired case is rewritten alone and several writers can each own their files. It decides nothing: every file reaches the Hub
// as written and all checks stay there. The token comes from standard input, as tools/fetch-run.ts reads it. One thing is done
// before sending: a literal of a set length written as a placeholder ({{domain:253}}, functions/length-literals.ts) is expanded
// and the expanded case is written back to its file, so the file is what the Hub receives and the model reads lengths, not counts.
//   node <skill directory>/tools/submit-plans.ts --hub %HUB_URL% --run <run id> --model <model> --plans <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { argumentsOf, bearerFrom, get, hubOrigin, itemFiles, RUN_ID, submitResult, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { isRecord } from '../functions/text.ts';

export const planItems = itemFiles;

const SHOWN_CHARS = 12_000;

/**
 * One case file read strictly, with a refusal that names the file, the place and the text around it. The shared reader only said
 * "不是完整的 UTF-8 JSON" for any of them, and in run 14 a model spent an hour on encodings for a missing closing brace.
 */
export function parsedPlanFile(name: string, bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${name} 不是合法的 UTF-8 文本；用 write_file 重新写这个文件`); }
  try { return JSON.parse(text); } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析';
    const at = /position (\d+)/.exec(message); const position = at ? Number(at[1]) : null;
    const around = position === null ? '' : `；出错位置第 ${position} 个字符，附近原文：${JSON.stringify(text.slice(Math.max(0, position - 60), position + 20))}`;
    throw new Error(`${name} 不是合法的 JSON（${message}）${around}。常见原因是括号或引号没有成对；改好这个文件再提交`);
  }
}

/** Expands the length placeholders of every case file in `directory`, rewriting only the files that had one; returns what each became. */
export async function expandPlanFiles(directory: string): Promise<string[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const lines: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const value = parsedPlanFile(name, await readFile(path));
    const text = JSON.stringify(value);
    if (!text.includes('{{')) continue;
    let expanded: ReturnType<typeof expandValue>;
    try { expanded = expandValue(value); } catch (error) { throw new Error(`${name}：${error instanceof Error ? error.message : '长度占位无法展开'}`); }
    if (!expanded.expansions.length) continue;
    await writeFile(path, JSON.stringify(expanded.value, null, 2) + '\n'); // the case file itself, as the model wrote it
    lines.push(...describeExpansions(name, expanded.expansions));
  }
  return lines;
}

/**
 * The item ids of the run, from the Hub's export of the run alone. A final verification runs a subset of the cases (the others
 * excluded), and the reference engine composes that volume from each case's sealed artifact without writing it again; here the
 * same plan directory is submitted and the files of items the run does not hold are left out, so a passed case's plan reaches
 * the new run byte for byte. In run 14 a model copied sixteen plans by hand for this and could not reproduce the long literals.
 */
async function runItems(origin: string, bearer: string, run: string): Promise<Set<string>> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8').decode(await get(`${origin}/run-export/${run}/run`, bearer)));
  if (!isRecord(value) || value.schema !== 'run-export@1' || !isRecord(value.run) || value.run.run !== run || !Array.isArray(value.run.items)) throw new Error('Hub 给的运行导出不合式或不是 --run 指定的运行');
  return new Set(value.run.items.filter(isRecord).map((item) => String(item.id)));
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'plans']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 必须是运行编号');
    const origin = hubOrigin(args.hub);
    const expanded = await expandPlanFiles(args.plans);
    if (expanded.length) process.stdout.write(`长度占位已展开并写回文件：\n${expanded.join('\n')}\n`);
    const files = await planItems(args.plans);
    const bearer = await bearerFrom(readToken);
    const held = await runItems(origin, bearer, args.run);
    const items = files.filter((item) => held.has(String(item.item))), left = files.filter((item) => !held.has(String(item.item)));
    if (!items.length) throw new Error(`--plans 目录里没有本运行的条目（本运行有 ${held.size} 个条目）；条目编号照 start_run 回执写`);
    if (left.length) process.stdout.write(`跳过 ${left.length} 个不属于本运行的条目文件（本运行没有这些条目，例如被 parameters.exclude 排除）：${left.map((item) => String(item.item)).join('、')}\n`);
    const { text, failed } = await submitResult(origin, bearer, { run: args.run, model: args.model, items });
    const path = join(args.plans, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    const clipped = text.length > SHOWN_CHARS;
    process.stdout.write(`${items.length} 个条目已提交\n${text.slice(0, SHOWN_CHARS)}\n${clipped ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，用 read_file 分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(`提交失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
