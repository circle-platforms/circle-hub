import {blockReviewIdentity} from './block-review-identity.ts';
import {assertionTarget,assertionCells} from './block-runtime.ts';
import {blockMeta,sourcePlan} from './blocks.ts';
import {authorTexts} from './generated/skills/command-tools/command-check/command-policy.ts';
import {selectedExpectedNodes} from './expected-nodes.ts';
import { typedAuthorityGaps, authorityRecovery } from './typed-authority.ts';
// Client deterministic generator, also called solely for byte recomputation by the Hub verifier. Node built-ins only.
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import FORMAT from '../tables/workbook-format.json' with { type: 'json' };
import { readSlots, type PlanSlots } from './slots.ts';
import { allowedCall, type RuntimeProfile } from './profile.ts';
import { runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { bindArguments, hasSingleLineValue } from './binding.ts';
import { encodeG, type GOptions } from './generated/skills/runner-workbook/workbook-writer/g-syntax.ts';
import { fillTemplate, readTemplate, TemplateError } from './generated/skills/runner-workbook/workbook-writer/workbook-template.ts';
export const GENERATOR = FORMAT.generator;
export interface GenerationFields {source_atoms?:unknown;bed_services?:unknown;manifest_sha256?:string;criteria_review?:unknown;expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; autoid: string; title: string; path?: string[]; priority?: string | null; steps: Array<{ text: string }> }
export interface GenerationInput { slots: PlanSlots; fields: GenerationFields; contract: RuntimeContract; profile: RuntimeProfile; plan_run: string; build: string; generator?: string }
export class GenerationError extends Error { readonly rule: string; readonly pointer: string; constructor(pointer: string, message: string, rule = 'generation') { super(`${pointer}：${message}`); this.name = 'GenerationError'; this.pointer = pointer; this.rule = rule; } }
const reject = (at: string, message: string): never => { throw new GenerationError(at, message); };
export function gOptions(object: string, method: string, contract: RuntimeContract, profile: RuntimeProfile): GOptions {
  const entry = runtimeMethod(contract, object, method); const allowed = allowedCall(profile, object, method);
  return { keywordNames: entry?.parameters.filter((p) => p.kind === 'positional_or_keyword' || p.kind === 'keyword_only').map((p) => p.name) ?? [], foldNewlines: profile.fold_newlines.some((v) => v.object === object && v.method === method), wait: Object.values(allowed?.parameters ?? {}).length > 0 && Object.values(allowed?.parameters ?? {}).every((v) => v === 'wait') };
}
function escape(text: string, at: string, xstring = true): string {
  if (typeof text !== 'string' || !text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/.test(text) || text.length > FORMAT.max_cell_chars || text.startsWith('=')) reject(at, '单元格文字不属于生成子集（公式前缀、无效 XML 字符或过长），不作静默修复');
  if (/_x[0-9a-fA-F]{4}_/.test(text)) throw new GenerationError(at, 'xstring_escape：内联文字的转义读法不一致；改用没有该序列的原文', 'xstring_escape');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
}
/** Column D of a case's first row (issue #144): the case's place in the mind map, the node texts from the root to the case
 * joined by ">". The runner only logs D, so it is free text for people. */
export const PATH_SEPARATOR = '>';
/** Column D of a step row: the step's own description, after the case's path on its first row. */
export function stepDescription(path: string | null, description: string | undefined): string { return [path, description].filter((value) => value !== null && value !== undefined).join('\n'); }
export function pathCell(path: unknown): string | null {
  return Array.isArray(path) && path.length > 0 && path.every((v) => typeof v === 'string') ? path.join(PATH_SEPARATOR) : null;
}
/** The canonical recipe of one case: everything its rows are generated from. */
export function caseRecipe(input: GenerationInput, slots: PlanSlots): unknown {
  const { fields, contract, profile } = input;
  return { slots:sourcePlan(slots), fields: { ...(fields.source_atoms!==undefined?{source_atoms:fields.source_atoms}:{}),expected_nodes:selectedExpectedNodes(fields.expected_nodes,slots)??null,command_catalog:fields.command_catalog??null,command_identities:fields.command_identities??null,autoid: fields.autoid, title: fields.title, path: fields.path ?? null, priority: fields.priority ?? null,...(blockMeta(slots)?{bed_services:fields.bed_services??null,manifest_sha256:fields.manifest_sha256??null,criteria_review:blockReviewIdentity(fields.criteria_review)}:{}), steps: fields.steps.map((v) => ({ text: v.text })) }, contract: { runtimeVersion: contract.runtimeVersion, digest: contract.pinned.identity }, profile, plan_run: input.plan_run, build: input.build, generator: GENERATOR };
}
/** The identity row's recipe digest: one case keeps its own recipe, several cases the ordered list of their recipes. */
export function recipeDigest(recipes: unknown[]): string {
  return createHash('sha256').update(canonicalJson(recipes.length === 1 ? recipes[0] : { cases: recipes }), 'utf8').digest('hex');
}
/** Rows are constructed only here; the independent workbook reader does not call this routine to interpret input. */
export function generateWorkbook(input: GenerationInput): Uint8Array { return generateWorkbookSet([input]); }
/** One workbook for the cases of one run (decision 104): the runner's template, then below its header the description row,
 * each case's rows in the given order followed by a blank row, and the closing case. One case gives exactly the single-case layout.
 * `merged` lets the cases come from several plan runs of the same contract, profile, build and generator, as the unsuccessful
 * volume of a delivery does (each case as it last went to the bed); the description row then names every plan run. Such a
 * workbook is not one plan run's recomputation, so it is never what a verification run binds. */
export function generateWorkbookSet(inputs: GenerationInput[], options: { merged?: boolean } = {}): Uint8Array {
  if (!inputs.length) reject('/cases', '至少一个已核验用例才可生成');
  const first = inputs[0]; const { contract, profile } = first; const many = inputs.length > 1;
  const at = (k: number, pointer: string) => many ? `/cases/${k}${pointer}` : pointer;
  for (const [k, input] of inputs.entries()) if (input.contract.pinned.identity !== contract.pinned.identity || input.contract.runtimeVersion !== contract.runtimeVersion || canonicalJson(input.profile) !== canonicalJson(profile) || (!options.merged && input.plan_run !== first.plan_run) || input.build !== first.build || input.generator !== first.generator) reject(at(k, '/context'), '同一份工作簿的用例必须共用同一合约、配置、计划运行、构建和生成器');
  if (new Set(inputs.map((input) => input.fields.autoid)).size !== inputs.length) reject('/cases', '同一份工作簿里的 autoid 重复');
  if (first.generator !== undefined && first.generator !== GENERATOR) reject('/generator', '生成器版本与当前包版本不符');
  const planRuns = [...new Set(inputs.map((input) => input.plan_run))];
  if (planRuns.some((run) => !run || !run.startsWith('run_') || /[\r\n]/.test(run)) || !first.build || /[\r\n]/.test(first.build)) reject('/context', '缺少已满足的计划运行号或锁定构建');
  if (contract.pinned.identity !== profile.digest || contract.runtimeVersion !== profile.runtimeVersion) reject('/identity', '合约身份与配置不符');
  if(profile.seats.some(seat=>!Number.isSafeInteger(seat.ordinal)||seat.ordinal<0||seat.ordinal>=profile.device_count))reject('/profile/seats','框架取不到那台设备，整卷不跑：对象序号超出冻结预检容量');
  const defaultAssertion=assertionTarget(contract,profile);
  if (!defaultAssertion) reject('/profile/allowed', '生成器需要唯一的已启用字面断言组合');
  const assertionSeat = profile.seats.find((v) => v.object === defaultAssertion!.call.object);
  if (assertionSeat && assertionSeat.ordinal >= profile.device_count) reject('/profile/seats', '断言对象的座位超出预检设备数');
  const plans: PlanSlots[] = inputs.map((input, k) => { const read = readSlots(input.slots); if (!read.ok) reject(at(k, '/slots'), read.problems[0].pointer + ' ' + read.problems[0].message); return read.ok ? read.slots : input.slots; });
  const digest = recipeDigest(inputs.map((input, k) => caseRecipe(input, plans[k])));
  const rows: Array<Array<string | number>> = [['', '', 0, describedRun(planRuns.join('、'), first.build)]];
  for (const [k, input] of inputs.entries()) { rows.push(...caseRows(input, plans[k], (pointer) => at(k, pointer))); rows.push([]); }
  rows.push(closingRow(profile.workbook.closing_row));
  if (rows.length > FORMAT.max_rows) reject('/rows', `工作簿 ${rows.length} 行，超过本包上限 ${FORMAT.max_rows} 行；把脑图拆成几份分别上传、各开一次运行，或填 autoid 一次编一条`);
  try {
    const template = readTemplate(profile.workbook);
    if (template.identity[1] !== contract.runtimeVersion || template.identity[2] !== contract.pinned.identity) reject('/profile/workbook/template', '运行器模板的运行时或合约身份与本运行的合约不符；换成这份合约配套的模板');
    const column = (number: number) => String.fromCharCode(64 + number);
    return fillTemplate(template, { [column(FORMAT.identity_generator_column)]: GENERATOR, [column(FORMAT.identity_recipe_column)]: digest }, rows, escape);
  } catch (error) { if (error instanceof TemplateError) reject('/profile/workbook/template', error.message); throw error; }
}
/** Column D of the description row, which the reader compares with the frozen plan run. */
export function describedRun(planRun: string, build: string): string { return `Author         : ${GENERATOR}\n计划运行 ${planRun}；构建 ${build}`; }
/** The closing case, C a number as in every other row. */
function closingRow(row: readonly string[]): Array<string | number> { return row.map((value, column) => column === 2 && value !== '' ? Number(value) : value); }
/** One case's rows; `at` places a pointer inside the case. */
function caseRows(input: GenerationInput, slots: PlanSlots, at: (pointer: string) => string): Array<Array<string | number>> {
  const { fields, contract, profile } = input;
  const gaps = typedAuthorityGaps(contract, profile, slots,fields.command_identities,fields.command_catalog,authorTexts(fields),fields.manifest_sha256,fields.bed_services);
  if (gaps.length) reject(at('/contract'), authorityRecovery(gaps));
  if (slots.bucket !== profile.bed || typeof fields.autoid !== 'string' || !new RegExp(profile.workbook.autoid_pattern, 'u').test(fields.autoid)) reject(at('/fields/autoid'), '自动化测试环境或 autoid 与已核验输入不符');
  if (typeof fields.title !== 'string' || !fields.title || !Array.isArray(fields.steps) || fields.steps.some((v) => typeof v.text !== 'string')) reject(at('/fields'), '缺少条目标题或步骤原文');
  const path = pathCell(fields.path); if (path === null || fields.path!.at(-1) !== fields.title) reject(at('/fields/path'), '缺少用例在脑图里的层级路径（从根到本用例的节点原文），或路径末尾不是本用例标题；重新开始运行以取得当前投影');
  if (!slots.expects.length) reject(at('/expects'), '至少一条溯源期望才可生成');
  const rows: Array<Array<string | number>> = []; let statement = FORMAT.statement_type;
  for (const [i, step] of slots.steps.entries()) {
    const method = runtimeMethod(contract, step.object, step.method); const allowed = allowedCall(profile, step.object, step.method);
    if (!method) reject(at(`/steps/${i}`), '步骤必须是合约启用的调用');
    if (!allowed) reject(at(`/steps/${i}`), '启用调用缺少参数角色配置，请先在配置里给参数定角色');
    if (Object.values(allowed!.parameters).some((v) => v === 'literal_assertion')) reject(at(`/steps/${i}`), '断言只写进 expects，不能直接写在 steps');
    const bound = bindArguments(method!, step, at(`/steps/${i}`), new Set(Object.entries(allowed!.parameters).filter(([, role]) => role === 'executor_return').map(([name]) => name))); if (bound.problems.length) reject(bound.problems[0].pointer, bound.problems[0].message);
    for (const value of bound.values) {
      if ((allowed!.unsupplied ?? []).includes(value.name)) reject(value.pointer, '该参数已声明永不传入');
      if (!Object.hasOwn(allowed!.parameters, value.name)) reject(value.pointer, '参数没有角色，请在配置里给它定角色');
      if (allowed!.parameters[value.name] === 'executor_return') reject(value.pointer, '该参数由执行器提供上一步的返回，模型不能填写');
      if (allowed!.parameters[value.name] === 'wait' && (!/^[0-9]+$/.test(String(value.value)) || Number(value.value) < 1 || profile.max_wait_seconds === null || Number(value.value) > profile.max_wait_seconds || value.pointer.includes('/keywords/') && Object.values(allowed!.parameters).every((role) => role === 'wait'))) reject(value.pointer, '等待必须是配置上限内的正整数位置参数');
    }
    const seat = profile.seats.find((v) => v.object === step.object);
    if (seat && seat.ordinal >= profile.device_count) reject(at(`/steps/${i}`), '座位序号超出预检设备数；派发前还须重核实际设备数');
    let g: string; try { g = encodeG(step, gOptions(step.object, step.method, contract, profile)); } catch (e) { return reject(at(`/steps/${i}/G`), e instanceof Error ? e.message : 'G 无法往返'); }
    rows.push([i === 0 ? fields.autoid : '', i === 0 ? FORMAT.case_priority : '', statement++, stepDescription(i === 0 ? path! : null, step.description), step.object, step.method, g,...(blockMeta(slots)?[step.save_as??'',step.input_register??'']:[])]);
    for (const [k, expect] of slots.expects.entries()) if (expect.after === i + 1) {
      if (!blockMeta(slots)&&!Object.values(allowed!.parameters).some((v) => v === 'device_cli' || v === 'host_shell')) reject(at(`/expects/${k}/after`), '期望不能跟在等待或断言之后');
      if (!expect.register&&!hasSingleLineValue(expect.text)) reject(at(`/expects/${k}/text`), '断言必须是有效单行原文，没有边缘空白、公式前缀或占位符');
      const target=assertionTarget(contract,profile,expect);if(!target)reject(at(`/expects/${k}`),'缺断言方法声明');
      const cells=assertionCells(expect,target!);
      const text=expect.register?'':encodeG({args:[cells.g],keywords:{}},{literalAssertion:true});
      rows.push(['', '', statement++, '',target!.call.object,target!.call.method,text,...(blockMeta(slots)?[cells.h,cells.i]:[])]);
    }
  }
  if (slots.expects.some((v) => v.after < 1 || v.after > slots.steps.length)) reject(at('/expects/after'), '期望的步骤号越界');
  return rows;
}
