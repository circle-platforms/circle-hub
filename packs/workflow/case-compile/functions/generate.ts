import {authorTexts} from './command-policy.ts';
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
import { encodeG, type GOptions } from './g-syntax.ts';
import { zipStore } from './zip-store.ts';
export const GENERATOR = FORMAT.generator;
export interface GenerationFields {expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; autoid: string; title: string; priority?: string | null; steps: Array<{ text: string }> }
export interface GenerationInput { slots: PlanSlots; fields: GenerationFields; contract: RuntimeContract; profile: RuntimeProfile; plan_run: string; build: string; generator?: string }
export class GenerationError extends Error { readonly rule: string; readonly pointer: string; constructor(pointer: string, message: string, rule = 'generation') { super(`${pointer}：${message}`); this.name = 'GenerationError'; this.pointer = pointer; this.rule = rule; } }
const reject = (at: string, message: string): never => { throw new GenerationError(at, message); };
export function gOptions(object: string, method: string, contract: RuntimeContract, profile: RuntimeProfile): GOptions {
  const entry = runtimeMethod(contract, object, method); const allowed = allowedCall(profile, object, method);
  return { keywordNames: entry?.parameters.filter((p) => p.kind === 'positional_or_keyword' || p.kind === 'keyword_only').map((p) => p.name) ?? [], foldNewlines: profile.fold_newlines.some((v) => v.object === object && v.method === method), wait: Object.values(allowed?.parameters ?? {}).length > 0 && Object.values(allowed?.parameters ?? {}).every((v) => v === 'wait') };
}
const NS = 'http://schemas.openxmlformats.org/';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function escape(text: string, at: string, xstring = true): string {
  if (typeof text !== 'string' || !text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/.test(text) || text.length > FORMAT.max_cell_chars || text.startsWith('=')) reject(at, '单元格文字不属于生成子集（公式前缀、无效 XML 字符或过长），不作静默修复');
  if (/_x[0-9a-fA-F]{4}_/.test(text)) throw new GenerationError(at, 'xstring_escape：内联文字的转义读法不一致；改用没有该序列的原文', 'xstring_escape');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
}
/** Rows are constructed only here; the independent workbook reader does not call this routine to interpret input. */
export function generateWorkbook(input: GenerationInput): Uint8Array {
  const read = readSlots(input.slots); if (!read.ok) reject('/slots', read.problems[0].pointer + ' ' + read.problems[0].message);
  const slots = read.ok ? read.slots : input.slots; const { fields, contract, profile } = input;
  const gaps = typedAuthorityGaps(contract, profile, slots,fields.command_identities,fields.command_catalog,authorTexts(fields));
  if (gaps.length) reject('/contract', authorityRecovery(gaps));
  if (input.generator !== undefined && input.generator !== GENERATOR) reject('/generator', '生成器版本与当前包版本不符');
  if (!input.plan_run || !input.plan_run.startsWith('run_') || /[\r\n]/.test(input.plan_run) || !input.build || /[\r\n]/.test(input.build)) reject('/context', '缺少已满足的计划运行号或锁定构建');
  if (contract.pinned.identity !== profile.digest || contract.runtimeVersion !== profile.runtimeVersion) reject('/identity', '合约身份与配置不符');
  if(profile.seats.some(seat=>!Number.isSafeInteger(seat.ordinal)||seat.ordinal<0||seat.ordinal>=profile.device_count))reject('/profile/seats','框架取不到那台设备，整卷不跑：对象序号超出冻结预检容量');
  if (slots.bucket !== profile.bed || typeof fields.autoid !== 'string' || !new RegExp(profile.workbook.autoid_pattern, 'u').test(fields.autoid)) reject('/fields/autoid', '台架或 autoid 与已核验输入不符');
  if (typeof fields.title !== 'string' || !fields.title || !Array.isArray(fields.steps) || fields.steps.some((v) => typeof v.text !== 'string')) reject('/fields', '缺少条目标题或步骤原文');
  const assertions = profile.allowed.filter((v) => Object.values(v.parameters).some((role) => role === 'literal_assertion'));
  if (assertions.length !== 1 || !runtimeMethod(contract, assertions[0].object, assertions[0].method)) reject('/profile/allowed', '生成器需要唯一的已启用字面断言组合');
  if (!slots.expects.length) reject('/expects', '至少一条溯源期望才可生成');
  const assertionSeat = profile.seats.find((v) => v.object === assertions[0].object);
  if (assertionSeat && assertionSeat.ordinal >= profile.device_count) reject('/profile/seats', '断言对象的座位超出预检设备数');
  const identity: Array<string | number> = [profile.workbook.identity_marker, contract.runtimeVersion, contract.pinned.identity, '', ''];
  identity[FORMAT.identity_generator_column - 1] = GENERATOR;
  identity[FORMAT.identity_recipe_column - 1] = createHash('sha256').update(canonicalJson({ slots, fields: { expected_nodes:selectedExpectedNodes(fields.expected_nodes,slots)??null,command_catalog:fields.command_catalog??null,command_identities:fields.command_identities??null,autoid: fields.autoid, title: fields.title, priority: fields.priority ?? null, steps: fields.steps.map((v) => ({ text: v.text })) }, contract: { runtimeVersion: contract.runtimeVersion, digest: contract.pinned.identity }, profile, plan_run: input.plan_run, build: input.build, generator: GENERATOR }), 'utf8').digest('hex');
  const rows: Array<Array<string | number>> = [
    identity,
    [...profile.workbook.header],
    ['', '', 0, `计划运行 ${input.plan_run}；构建 ${input.build}`],
  ];
  for (const [i, step] of slots.steps.entries()) {
    const method = runtimeMethod(contract, step.object, step.method); const allowed = allowedCall(profile, step.object, step.method);
    if (!method) reject(`/steps/${i}`, '步骤必须是合约启用的调用');
    if (!allowed) reject(`/steps/${i}`, '启用调用缺少参数角色配置，请先在配置里给参数定角色');
    if (Object.values(allowed!.parameters).some((v) => v === 'literal_assertion')) reject(`/steps/${i}`, '断言只写进 expects，不能直接写在 steps');
    const bound = bindArguments(method!, step, `/steps/${i}`, new Set(Object.entries(allowed!.parameters).filter(([, role]) => role === 'executor_return').map(([name]) => name))); if (bound.problems.length) reject(bound.problems[0].pointer, bound.problems[0].message);
    for (const value of bound.values) {
      if ((allowed!.unsupplied ?? []).includes(value.name)) reject(value.pointer, '该参数已声明永不传入');
      if (!Object.hasOwn(allowed!.parameters, value.name)) reject(value.pointer, '参数没有角色，请在配置里给它定角色');
      if (allowed!.parameters[value.name] === 'executor_return') reject(value.pointer, '该参数由执行器提供上一步的返回，模型不能填写');
      if (allowed!.parameters[value.name] === 'wait' && (!/^[0-9]+$/.test(String(value.value)) || Number(value.value) < 1 || profile.max_wait_seconds === null || Number(value.value) > profile.max_wait_seconds || value.pointer.includes('/keywords/') && Object.values(allowed!.parameters).every((role) => role === 'wait'))) reject(value.pointer, '等待必须是配置上限内的正整数位置参数');
    }
    const seat = profile.seats.find((v) => v.object === step.object);
    if (seat && seat.ordinal >= profile.device_count) reject(`/steps/${i}`, '座位序号超出预检设备数；派发前还须重核实际设备数');
    let g: string; try { g = encodeG(step, gOptions(step.object, step.method, contract, profile)); } catch (e) { return reject(`/steps/${i}/G`, e instanceof Error ? e.message : 'G 无法往返'); }
    rows.push([i === 0 ? fields.autoid : '', fields.priority ?? '', FORMAT.statement_type, fields.title, step.object, step.method, g]);
    for (const [k, expect] of slots.expects.entries()) if (expect.after === i + 1) {
      if (!Object.values(allowed!.parameters).some((v) => v === 'device_cli' || v === 'host_shell')) reject(`/expects/${k}/after`, '期望不能跟在等待或断言之后');
      if (!hasSingleLineValue(expect.text)) reject(`/expects/${k}/text`, '断言必须是有效单行原文，没有边缘空白、公式前缀或占位符');
      const text = encodeG({ args: [expect.text], keywords: {} }, { literalAssertion: true });
      rows.push(['', '', FORMAT.statement_type, expect.text, assertions[0].object, assertions[0].method, text]);
    }
  }
  if (slots.expects.some((v) => v.after < 1 || v.after > slots.steps.length)) reject('/expects/after', '期望的步骤号越界');
  if (profile.workbook.closing_row.slice(4).some((v) => v !== '')) reject('/profile/workbook/closing_row', '收尾行 E–I 必须为空');
  rows.push([], [...profile.workbook.closing_row]);
  if (rows.length > FORMAT.max_rows) reject('/rows', '单用例工作簿行数超过本包上限');
  let sheetData = ''; for (const [r, row] of rows.entries()) {
    let cells = ''; for (const [c, value] of row.entries()) {
      if (value === '') continue;
      const reference = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (c === 2 && r > 1) {
        if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) === 1) reject(`/${reference}`, 'C 列只能是本轮非初始化的整数类型');
        cells += `<c r="${reference}"><v>${value}</v></c>`;
      } else cells += `<c r="${reference}" t="inlineStr"${c === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${escape(String(value), '/' + reference)}</t></is></c>`;
    }
    sheetData += `<row r="${r + 1}">${cells}</row>`;
    if (Buffer.byteLength(sheetData, 'utf8') > FORMAT.max_workbook_bytes) reject('/bytes', '工作簿超出本包字节上限');
  }
  const sheet = escape(profile.workbook.sheet, '/profile/workbook/sheet');
  const range = `'${profile.workbook.sheet.replaceAll("'", "''")}'!$A$2:$I$2`;
  const texts = [
    `${XML}<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    `${XML}<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    `${XML}<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="${escape(profile.workbook.range_name, '/range')}">${escape(range, '/range', false)}</definedName></definedNames></workbook>`,
    `${XML}<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    `${XML}<styleSheet xmlns="${NS}spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    `${XML}<worksheet xmlns="${NS}spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
  ];
  const bytes = zipStore(FORMAT.members.map((name, i) => ({ name, bytes: Buffer.from(texts[i], 'utf8') })));
  if (bytes.length > FORMAT.max_workbook_bytes) reject('/bytes', '工作簿超出本包字节上限');
  return bytes;
}
