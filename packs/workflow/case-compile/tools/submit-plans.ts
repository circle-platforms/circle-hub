import { CallFailure } from '../functions/text.ts';
import { planStateOf } from '../functions/plan-state.ts';
import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fidelityBrief, fidelityProblems, type FidelityCode, type FidelityProblem } from '../functions/fidelity.ts';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { planDataOf } from '../functions/subject.ts';
import { isRecord } from '../functions/text.ts';
import { readSubmittedItemFiles, readTokenFromStdin, requireBearerToken, getRetrying, submitResultRetrying, type RetryControl } from '../functions/hub-retry.ts';
import { argumentsOf, hubOrigin, RUN_ID, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { formatCallError } from '../functions/text.ts';

export async function planItems(directory: string): Promise<Array<{ [key: string]: unknown }>> {
  return readSubmittedItemFiles(directory, {
    flag: 'plans',
    itemKind: '自动化用例',
    repairHint: '再做脚本合并',
    validateItem: (value, fileName) => {
      if (!isRecord(value) || typeof value.item !== 'string' || !value.item || typeof value.handling !== 'string') {
        throw new CallFailure('invalid_parameters', `${fileName} 不是一个条目；写 {"item":"<编号>","handling":"handled","slots":{"plan":[…]}}`, "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts");
      }
      return value;
    },
  });
}

const SHOWN_CHARS = 12_000;

export const SKIPPED_NOTE = (items: string[]): string => items.map((item) => `原始用例 ${item}，还没有完成脚本编写，状态未知。原因缺资料，下一步由编写模型按原始用例继续编写；声明跳过不是已核验的不可编写结论；已有具名缺失事实出口时按出口处理，否则继续编写或补齐证据；计数只陈述已记录尝试，不证明失败归因。决定者程序。`).join('\n') + '\n';

export function parsedPlanFile(name: string, bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CallFailure('invalid_parameters', `${name} 不是合法的 UTF-8 文本`, '请把此文件重新写为 UTF-8 JSON 后重试脚本合并', { path: name }); }
  try { return JSON.parse(text); }
  catch { throw new CallFailure('invalid_parameters', `${name} 不是合法的 JSON；原生解析器未提供结构化偏移，具体字符位置未知`, '请修复此文件的 JSON 结构，再重试脚本合并；不根据错误散文猜测位置', { path: name, legal_form: '{"item":"<编号>","handling":"handled","slots":{"plan":[]}}' }); }
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
    try { expanded = expandValue(value); } catch (error) { throw new CallFailure('invalid_parameters', `${name}：${error instanceof Error ? error.message : '长度占位无法展开'}`, "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts"); }
    if (!expanded.expansions.length) continue;
    await writeFile(path, JSON.stringify(expanded.value, null, 2) + '\n'); // the case file itself, as the model wrote it
    lines.push(...describeExpansions(name, expanded.expansions));
  }
  return lines;
}

export interface HeldRunItem { label: string; recomposition: unknown }
const LOCAL_FIDELITY_BLOCKS = new Set<FidelityCode>(['fidelity_missing', 'fidelity_stale', 'fidelity_shape']);

/** Local precheck sharing functions/fidelity with the Hub: refuses missing/stale/malformed data.fidelity before spending a repair round. */
export function localFidelityBlocks(
  items: readonly Record<string, unknown>[],
  held: ReadonlyMap<string, HeldRunItem>,
): Array<{ item: string; label: string; problem: FidelityProblem }> {
  const blocks: Array<{ item: string; label: string; problem: FidelityProblem }> = [];
  for (const record of items) {
    if (!planStateOf(record).process) continue;
    const id = String(record.item);
    const info = held.get(id);
    if (!info) continue;
    const data = planDataOf(record);
    const { fidelity, ...plan } = isRecord(data) ? data : {};
    const brief = fidelityBrief(id, info.recomposition, plan);
    if (!brief) continue;
    const { problems } = fidelityProblems(brief, fidelity);
    for (const problem of problems) {
      if (LOCAL_FIDELITY_BLOCKS.has(problem.code)) blocks.push({ item: id, label: info.label, problem });
    }
  }
  return blocks;
}

async function runItems(origin: string, bearer: string, run: string, retry?: RetryControl): Promise<Map<string, HeldRunItem>> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8').decode(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry)));
  if (!isRecord(value) || value.schema !== 'run-export@1' || !isRecord(value.run) || value.run.run !== run || !Array.isArray(value.run.items)) throw new CallFailure('invalid_parameters', 'Hub 返回的原始用例不完整或与本次脚本编写不符', "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts");
  return new Map(value.run.items.filter(isRecord).map((item) => {
    const fields = isRecord(item.fields) ? item.fields : {};
    const label = [fields.autoid, fields.title].filter((text) => typeof text === 'string' && text).join(' ') || '编号和标题未知';
    const recomposition = isRecord(fields.recomposition) ? fields.recomposition.record : undefined;
    return [String(item.id), { label, recomposition }];
  }));
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'plans']);
    if (!RUN_ID.test(args.run)) throw new CallFailure('invalid_parameters', '--run 请使用本次脚本编写的编号', "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts");
    const origin = hubOrigin(args.hub);
    const expanded = await expandPlanFiles(args.plans);
    if (expanded.length) process.stdout.write(`自动化用例的具体取值已写回文件：\n${expanded.join('\n')}\n`);
    const files = await planItems(args.plans);
    const bearer = await requireBearerToken(readToken);
    const held = await runItems(origin, bearer, args.run, retry);
    const items = files.filter((item) => held.has(String(item.item))), left = files.filter((item) => !held.has(String(item.item)));
    if (!items.length) throw new CallFailure('invalid_parameters', `--plans 目录里没有本次脚本编写的自动化用例，本次共有 ${held.size} 条原始用例；请使用下载的原始用例继续编写`, "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts");
    const fidelityBlocks = localFidelityBlocks(items, held);
    if (fidelityBlocks.length) {
      const detail = fidelityBlocks.map((b) => `- ${b.label}（${b.item}）：${b.problem.message}`).join('\n');
      throw new CallFailure('invalid_parameters', `以下 ${fidelityBlocks.length} 份自动化用例尚未完成场景保真审计，未发往 Hub（不占修复次数；Hub 的核对结论仍为准）：\n`
        + `${detail}。\n`
        + '请依次执行下面 3 步后再重跑 submit-plans.ts：\n'
        + '1) node <技能目录>/tools/fidelity-brief.ts --run <脚本编写目录>/run.json --plans <自动化用例目录> --out <核对目录>\n'
        + '2) 用新开的子代理逐份读取 to_audit 中的 .brief.json，按文件内 rules 写出同名 .verdict.json\n'
        + '3) node <技能目录>/tools/fidelity-apply.ts --run <脚本编写目录>/run.json --plans <自动化用例目录> --briefs <核对目录>（确认 ready=true）', "请依据本次错误的位置和说明修正计划或参数，再重试 submit-plans.ts");
    }
    if (left.length) process.stdout.write(`另有 ${left.length} 份自动化用例不属于本次脚本编写，未做脚本合并\n`);
    const { text, failed } = await submitResultRetrying(origin, bearer, { run: args.run, model: args.model, items }, retry);
    const path = join(args.plans, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    const clipped = text.length > SHOWN_CHARS;
    process.stdout.write(`${items.length} 份自动化用例已交给 Hub 做脚本合并\n${text.slice(0, SHOWN_CHARS)}\n${clipped ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，请分段读完\n` : `全文在 ${path}\n`}`);
    const skipped = items.filter((item) => item.handling === 'skipped').map((item) => held.get(String(item.item))!.label);
    if (skipped.length) process.stdout.write(SKIPPED_NOTE(skipped));
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
