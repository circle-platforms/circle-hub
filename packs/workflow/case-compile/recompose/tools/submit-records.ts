import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
// Recomposition, one file per case. The model writes only what takes judgment: the method, what it adapted, what it made
// concrete and what is missing. Everything the projection already knows (the atoms, their spans, the original ledger, the
// coverage) is filled in here, as InfoTest's fill_mechanical_fields does, so a model never retypes author text. It decides
// nothing: the Hub checks every record, and a file that says nothing about an atom leaves that atom settled.
//   node <skill directory>/tools/submit-records.ts --hub %HUB_URL% --run <run id> --model <model> --records <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { getRetrying, readSubmittedItemFiles, readTokenFromStdin, requireBearerToken, submitResultRetrying, type RetryControl } from '../functions/hub-retry.ts';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import RECOMPOSE_FORMAT from '../tables/recompose-format.json' with { type: 'json' };

const SHOWN_CHARS = 12_000;
type Row = { [key: string]: any };
const list = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];

/** The exit a state carries when the model names none: the case goes on to the writer. */
const onward = (atom: string) => ({ action: '进入编写', object: atom, owner: '编写模型', due: '编写提交之前' });

const ALLOWED_RECOMPOSE_FILE_KEYS = new Set([
  'item',
  'method',
  'slots',
  'states',
  'adapted',
  'concretizations',
  'unknowns',
  'intent',
  'expectation',
  'candidates',
]);
const FULL_SCHEMA_KEYS = new Set([
  'schema',
  'case',
  'contract',
  'atoms',
  'expectation_slots',
  'coverage',
  'ledgers',
  'sources',
]);
const RECOMPOSE_METHOD_KINDS: readonly string[] = RECOMPOSE_FORMAT.method_kinds;
const LITE_SHAPE_HINT =
  '{"item":"<下载文件中的 id>","method":{"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"}}（可选字段仅 slots/states/adapted/concretizations/unknowns），严禁写完整 schema 字段或 "handling"';

/** Enforces the single lite record format on both model files and direct `recordFor` callers. */
export function assertValidRecomposeShape(value: unknown, contextLabel: string, requireItem: boolean): Row {
  if (!isRecord(value)) {
    throw new CallFailure("invalid_parameters", `${contextLabel} 必须使用精简格式 JSON 对象（实际不是对象）。请按单一精简格式重写为 ${LITE_SHAPE_HINT}`, "提供单条精简重组 JSON 对象；按错误中展示的 item 与 method 字段形状重写");
  }
  const extraKeys = Object.keys(value).filter((key) => !ALLOWED_RECOMPOSE_FILE_KEYS.has(key));
  if (extraKeys.length > 0) {
    const hasFullSchema = extraKeys.some((key) => FULL_SCHEMA_KEYS.has(key));
    const kindNote = hasFullSchema
      ? '不得使用完整的 recompose-record@1 结构，'
      : '';
    throw new CallFailure("invalid_parameters", `${contextLabel} 必须使用精简格式（${kindNote}不允许顶层字段 ${extraKeys.join('、')}）。请按单一精简格式改写为 ${LITE_SHAPE_HINT}`, "移除不允许的顶层字段，仅提交精简重组形状；完整机械字段由工具生成");
  }
  for (const listKey of ['slots', 'states', 'adapted', 'concretizations', 'unknowns', 'candidates'] as const) {
    if (value[listKey] !== undefined && !Array.isArray(value[listKey])) {
      throw new CallFailure("invalid_parameters", `${contextLabel} 必须使用精简格式（顶层 "${listKey}" 应为数组，禁止写包装对象）。请改写为 ${LITE_SHAPE_HINT}`, "把错误点名的精简记录列表字段改为数组，勿套额外包装对象");
    }
  }
  if (requireItem && (typeof value.item !== 'string' || !value.item)) {
    throw new CallFailure("invalid_parameters", `${contextLabel} 缺少非空字符串字段 "item"。请按单一精简格式写为 ${LITE_SHAPE_HINT}`, "从下载条目的 id 复制非空字符串到 item，保留精简重组形状");
  }
  if (value.method === undefined) {
    throw new CallFailure("invalid_parameters", `${contextLabel} 缺少用例重组的方法（顶层 method 字段）。请补齐 "method": {"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"} 后再做用例重组`, "补齐顶层 method 对象及 kind、text、sources、basis 后重新自检");
  }
  if (!isRecord(value.method)) {
    throw new CallFailure("invalid_parameters", `${contextLabel} 的顶层 "method" 必须是 JSON 对象（实际为 ${typeof value.method}）。请改写为 {"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"} 后再做用例重组`, "把 method 写成对象，明确 kind、text、sources 和 basis");
  }
  const kind = value.method.kind;
  if (typeof kind !== 'string' || !RECOMPOSE_METHOD_KINDS.includes(kind)) {
    throw new CallFailure("invalid_parameters", `${contextLabel} 的 method.kind（${String(kind ?? '')}）不在允许范围内，只能填 ${RECOMPOSE_METHOD_KINDS.join(' / ')}。请按单一精简格式修正 method 字段后再做用例重组`, "从错误列出的已声明 method.kind 中选一个值，不使用未声明名称");
  }
  return value as Row;
}

/** The complete recompose-record@1 of one case: the frozen item plus the model's file. */
export function recordFor(item: Row, file: Row, model: string): Row {
  const fields = item.fields ?? {}, atoms = list(fields.atoms);
  const named = [fields.case_id, atoms.find((a) => a.kind === 'intent')?.text].filter(Boolean).join(' ') || '编号和标题未知';
  assertValidRecomposeShape(file, `原始用例 ${named}`, false);
  const atom = (id: unknown) => atoms.find((a) => a.id === id);
  const quote = (a: Row | undefined) => a === undefined ? undefined : { text: a.text, quote_ref: a.reference, verbatim: true };
  const expectations = atoms.filter((a) => a.kind === 'expectation');
  const given = new Map(list(file.slots).map((slot) => [slot.atom, slot]));
  for (const id of given.keys()) if (!expectations.some((a) => a.id === id)) throw new CallFailure("invalid_parameters", `原始用例 ${named} 的期望不是这条原始用例的原句，请从原始用例逐字复制`, "把 slots 中的 atom 改为当前原始用例的期望原句身份，勿引用其他用例");
  const slots = expectations.map((a, index) => ({ slot: `e${index + 1}`, atom: a.id, knowledge_location: 'has_verification_knowledge', evidence: [], proposal: null, ...given.get(a.id) }));
  const mapped: { [atom: string]: string[] } = {}, unmapped: string[] = [];
  for (const a of atoms) {
    const targets = a.kind === 'expectation' ? slots.filter((slot) => slot.atom === a.id)
      : a.kind === 'intent' ? slots
        : slots.filter((slot) => (atom(slot.atom)?.after ?? []).includes(a.id));
    if (targets.length) mapped[a.id] = targets.map((slot) => slot.slot); else unmapped.push(a.id);
  }
  const states = new Map(list(file.states).map((state) => [state.atom, state]));
  for (const id of states.keys()) if (atom(id) === undefined) throw new CallFailure("invalid_parameters", `原始用例 ${named} 没有这条原句，请从原始用例逐字复制`, "把 states 中的 atom 改为当前原始用例已有的原句身份");
  const candidates = list(file.candidates).map((row) => ({ found_by: model, ...row, signing_authority: false }));
  return {
    schema: 'recompose-record@1',
    case: { id: fields.case_id, source_ref: fields.source_ref, node: fields.node },
    contract: {
      intent: quote(atom(file.intent) ?? atoms.find((a) => a.kind === 'intent') ?? atoms.find((a) => a.kind === 'action')),
      method: file.method,
      expectation: quote(atom(file.expectation) ?? expectations[0]),
    },
    expectation_slots: slots,
    coverage: { author_atoms: atoms.map((a) => a.id), mapped, unmapped },
    atoms: atoms.map((a) => ({ id: a.id, kind: a.kind, text: a.text, quote_ref: a.reference, span: [a.start, a.end] })),
    sources: {
      governing: [],
      candidates,
      states: atoms.map((a) => {
        const state = states.get(a.id);
        return { atom: a.id, state: 'settled', adjudicated_by: null, reason: '模型没有提出缺口', exit: onward(a.id), ...state };
      }),
    },
    ledgers: {
      original: atoms.map((a) => ({ atom: a.id, text: a.text, quote_ref: a.reference, span: [a.start, a.end] })),
      adapted: list(file.adapted).map((row) => ({ commands: [], equivalence_refs: [], load_bearing: false, conditions: [], source_of_value: atom(row.atom)?.reference, ...row })),
      concretizations: list(file.concretizations).map((row) => ({ decided_by: model, source_of_value: row.value_ref, ...row })),
      rebindings: [],
    },
    status: 'complete',
    unknowns: list(file.unknowns),
  };
}

/** What one case's file becomes in the submission: the entry the Hub receives and check-record checks (one builder for both). */
export function itemSubmission(item: Row, file: Row, model: string): Row {
  const data = recordFor(item, file, model);
  return { item: item.id, handling: 'handled', slots: { record: [{ text: '模型的重组判断', quotes: data.atoms.map((a: Row) => ({ reference: a.quote_ref, text: a.text })), data }] } };
}

/** The whole submission: one record per case file, and every frozen item accounted for. */
export function submissionFor(run: Row, files: Row[], model: string): Row {
  const items = list(run.items), byId = new Map(items.map((item) => [item.id, item]));
  const missing = items.filter((item) => !files.some((file) => file.item === item.id)).map((item) => item.id);
  if (missing.length) throw new CallFailure("invalid_parameters", `还有 ${missing.length} 条原始用例没有重组后的用例；请每条原始用例写一个文件，一起交给 Hub 核对`, "为缺失的每条原始用例补一份精简重组记录，完整覆盖当前运行后再提交");
  return {
    run: run.run, model,
    items: files.map((file) => {
      const item = byId.get(file.item);
      if (item === undefined) throw new CallFailure("invalid_parameters", `自动化用例文件不属于本次用例重组的原始用例`, "只提交本次下载运行 items 中的原始用例，其他运行另行重组");
      return itemSubmission(item, file, model);
    }),
  };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = parseCliOptions(argv, { hub: true, run: true, model: true, records: true }, 'submit-records.ts --hub <MCP地址> --run <运行编号> --model <模型标识> --records <记录目录>') as Record<string, string>;
    if (!RUN_ID.test(args.run)) throw new CallFailure("invalid_parameters", '--run 请使用本次用例重组或脚本编写的编号', "使用本次用例重组的运行编号作为 --run 后重试");
    const origin = parseHubOrigin(args.hub);
    const files = await readSubmittedItemFiles(args.records, {
      flag: 'records',
      itemKind: '用例重组记录',
      repairHint: '再做用例重组',
      validateItem: (value, fileName) => assertValidRecomposeShape(value, `--records 目录下的 ${fileName}`, true),
    });
    const bearer = await requireBearerToken(readToken);
    const bytes = await getRetrying(`${origin}/run-export/${args.run}/run`, bearer, retry);
    let exported: any;
    try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CallFailure('temporarily_unavailable', '原始用例导出不是完整的 UTF-8 JSON', '请维护者恢复完整运行导出，再按同一请求读取原始用例'); }
    if (exported?.schema !== 'run-export@1' || exported.run?.run !== args.run) throw new CallFailure("temporarily_unavailable", 'Hub 返回的原始用例不完整', "请维护者核对运行导出的 schema 与运行身份，恢复完整原件后按同一请求读取");
    const { text, failed } = await submitResultRetrying(origin, bearer, submissionFor(exported.run, files, args.model), retry);
    const path = join(args.records, `answer-${Date.now()}.txt`);
    await writeFile(path, Buffer.from(text), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${files.length} 条重组后的用例已交给 Hub 核对\n${text.slice(0, SHOWN_CHARS)}\n${text.length > SHOWN_CHARS ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，请分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
