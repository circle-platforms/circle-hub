import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { argumentsOf, bearerFrom, get, hubOrigin, itemFiles, RUN_ID, submitResult, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { isRecord } from '../functions/text.ts';

export const planItems = itemFiles;

const SHOWN_CHARS = 12_000;

export const SKIPPED_NOTE = (items: string[]): string => items.map((item) => `原始用例 ${item}，还没有完成脚本编写，状态未知。原因缺资料，下一步由编写模型按原始用例继续编写；只有 Hub 确认缺资料，或最多重交的次数用完仍未核对正确，才能结束脚本编写。决定者程序。`).join('\n') + '\n';

export function parsedPlanFile(name: string, bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${name} 不是合法的 UTF-8 文本；请重新写这个文件`); }
  try { return JSON.parse(text); } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析';
    const at = /position (\d+)/.exec(message); const position = at ? Number(at[1]) : null;
    const around = position === null ? '' : `；出错位置第 ${position} 个字符，附近原文：${JSON.stringify(text.slice(Math.max(0, position - 60), position + 20))}`;
    throw new Error(`${name} 不是合法的 JSON（${message}）${around}。常见原因是括号或引号没有成对；改好这个文件再做脚本合并`);
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

async function runItems(origin: string, bearer: string, run: string): Promise<Map<string, string>> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8').decode(await get(`${origin}/run-export/${run}/run`, bearer)));
  if (!isRecord(value) || value.schema !== 'run-export@1' || !isRecord(value.run) || value.run.run !== run || !Array.isArray(value.run.items)) throw new Error('Hub 返回的原始用例不完整或与本次脚本编写不符');
  return new Map(value.run.items.filter(isRecord).map((item) => { const fields = isRecord(item.fields) ? item.fields : {}; return [String(item.id), [fields.autoid, fields.title].filter((text) => typeof text === 'string' && text).join(' ') || '编号和标题未知']; }));
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'plans']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const expanded = await expandPlanFiles(args.plans);
    if (expanded.length) process.stdout.write(`自动化用例的具体取值已写回文件：\n${expanded.join('\n')}\n`);
    const files = await planItems(args.plans);
    const bearer = await bearerFrom(readToken);
    const held = await runItems(origin, bearer, args.run);
    const items = files.filter((item) => held.has(String(item.item))), left = files.filter((item) => !held.has(String(item.item)));
    if (!items.length) throw new Error(`--plans 目录里没有本次脚本编写的自动化用例，本次共有 ${held.size} 条原始用例；请使用下载的原始用例继续编写`);
    if (left.length) process.stdout.write(`另有 ${left.length} 份自动化用例不属于本次脚本编写，未做脚本合并\n`);
    const { text, failed } = await submitResult(origin, bearer, { run: args.run, model: args.model, items });
    const path = join(args.plans, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    const clipped = text.length > SHOWN_CHARS;
    process.stdout.write(`${items.length} 份自动化用例已交给 Hub 做脚本合并\n${text.slice(0, SHOWN_CHARS)}\n${clipped ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，请分段读完\n` : `全文在 ${path}\n`}`);
    const skipped = items.filter((item) => item.handling === 'skipped').map((item) => held.get(String(item.item))!);
    if (skipped.length) process.stdout.write(SKIPPED_NOTE(skipped));
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(`脚本合并未完成：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
