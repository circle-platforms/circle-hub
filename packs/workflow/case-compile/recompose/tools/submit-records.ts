// Recomposition, one file per case. The model writes only what takes judgment: the method, what it adapted, what it made
// concrete and what is missing. Everything the projection already knows (the atoms, their spans, the original ledger, the
// coverage) is filled in here, as InfoTest's fill_mechanical_fields does, so a model never retypes author text. It decides
// nothing: the Hub checks every record, and a file that says nothing about an atom leaves that atom settled.
//   node '<skill directory>/tools/submit-records.ts' --hub %HUB_URL% --run '<run id>' --model '<model>' --records '<directory>' <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, hubOrigin, RUN_ID, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { getRetrying, readSubmittedItemFiles, readTokenFromStdin, requireBearerToken, submitResultRetrying, type RetryControl } from '../functions/hub-retry.ts';
import { formatCallError, isRecord } from '../functions/text.ts';
import RECOMPOSE_FORMAT from '../tables/recompose-format.json' with { type: 'json' };
import cli from './submit-records.cli.json' with { type: 'json' };

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
  '{"item":"<下载文件中的 id>","method":{"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<原句或手册引用>"],"basis":"为什么这样验证"}}（可选字段仅 slots/states/adapted/concretizations/unknowns），严禁写完整 schema 字段或 "handling"';

/** Enforces the single lite record format on both model files and direct `recordFor` callers. */
export function assertValidRecomposeShape(value: unknown, contextLabel: string, requireItem: boolean): Row {
  if (!isRecord(value)) {
    throw new Error(`${contextLabel} 必须使用精简格式 JSON 对象（实际不是对象）。请按单一精简格式重写为 ${LITE_SHAPE_HINT}`);
  }
  const extraKeys = Object.keys(value).filter((key) => !ALLOWED_RECOMPOSE_FILE_KEYS.has(key));
  if (extraKeys.length > 0) {
    const hasFullSchema = extraKeys.some((key) => FULL_SCHEMA_KEYS.has(key));
    const kindNote = hasFullSchema
      ? '不得使用完整的 recompose-record@1 结构，'
      : '';
    throw new Error(
      `${contextLabel} 必须使用精简格式（${kindNote}不允许顶层字段 ${extraKeys.join('、')}）。请按单一精简格式改写为 ${LITE_SHAPE_HINT}`,
    );
  }
  for (const listKey of ['slots', 'states', 'adapted', 'concretizations', 'unknowns', 'candidates'] as const) {
    if (value[listKey] !== undefined && !Array.isArray(value[listKey])) {
      throw new Error(
        `${contextLabel} 必须使用精简格式（顶层 "${listKey}" 应为数组，禁止写包装对象）。请改写为 ${LITE_SHAPE_HINT}`,
      );
    }
  }
  if (requireItem && (typeof value.item !== 'string' || !value.item)) {
    throw new Error(`${contextLabel} 缺少非空字符串字段 "item"。请按单一精简格式写为 ${LITE_SHAPE_HINT}`);
  }
  if (value.method === undefined) {
    throw new Error(
      `${contextLabel} 缺少用例重组的方法（顶层 method 字段）。请补齐 "method": {"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"} 后再做用例重组`,
    );
  }
  if (!isRecord(value.method)) {
    throw new Error(
      `${contextLabel} 的顶层 "method" 必须是 JSON 对象（实际为 ${typeof value.method}）。请改写为 {"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"} 后再做用例重组`,
    );
  }
  const kind = value.method.kind;
  if (typeof kind !== 'string' || !RECOMPOSE_METHOD_KINDS.includes(kind)) {
    throw new Error(
      `${contextLabel} 的 method.kind（${String(kind ?? '')}）不在允许范围内，只能填 ${RECOMPOSE_METHOD_KINDS.join(' / ')}。请按单一精简格式修正 method 字段后再做用例重组`,
    );
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
  for (const id of given.keys()) if (!expectations.some((a) => a.id === id)) throw new Error(`原始用例 ${named} 的期望不是这条原始用例的原句，请从原始用例逐字复制`);
  const slots = expectations.map((a, index) => ({ slot: `e${index + 1}`, atom: a.id, knowledge_location: 'has_verification_knowledge', evidence: [], proposal: null, ...given.get(a.id) }));
  const mapped: { [atom: string]: string[] } = {}, unmapped: string[] = [];
  for (const a of atoms) {
    const targets = a.kind === 'expectation' ? slots.filter((slot) => slot.atom === a.id)
      : a.kind === 'intent' ? slots
        : slots.filter((slot) => (atom(slot.atom)?.after ?? []).includes(a.id));
    if (targets.length) mapped[a.id] = targets.map((slot) => slot.slot); else unmapped.push(a.id);
  }
  const states = new Map(list(file.states).map((state) => [state.atom, state]));
  for (const id of states.keys()) if (atom(id) === undefined) throw new Error(`原始用例 ${named} 没有这条原句，请从原始用例逐字复制`);
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

/** The whole submission: one record per case file, and every frozen item accounted for. */
export function submissionFor(run: Row, files: Row[], model: string): Row {
  const items = list(run.items), byId = new Map(items.map((item) => [item.id, item]));
  const missing = items.filter((item) => !files.some((file) => file.item === item.id)).map((item) => item.id);
  if (missing.length) throw new Error(`还有 ${missing.length} 条原始用例没有重组后的用例；请每条原始用例写一个文件，一起交给 Hub 核对`);
  return {
    run: run.run, model,
    items: files.map((file) => {
      const item = byId.get(file.item);
      if (item === undefined) throw new Error(`自动化用例文件不属于本次用例重组的原始用例`);
      const data = recordFor(item, file, model);
      return { item: item.id, handling: 'handled', slots: { record: [{ text: '模型的重组判断', quotes: data.atoms.map((a: Row) => ({ reference: a.quote_ref, text: a.text })), data }] } };
    }),
  };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'records']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const files = await readSubmittedItemFiles(args.records, {
      flag: 'records',
      itemKind: '用例重组记录',
      repairHint: '再做用例重组',
      validateItem: (value, fileName) => assertValidRecomposeShape(value, `--records 目录下的 ${fileName}`, true),
    });
    const bearer = await requireBearerToken(readToken, cli);
    const exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await getRetrying(`${origin}/run-export/${args.run}/run`, bearer, retry)));
    if (exported?.schema !== 'run-export@1' || exported.run?.run !== args.run) throw new Error('Hub 返回的原始用例不完整');
    const { text, failed } = await submitResultRetrying(origin, bearer, submissionFor(exported.run, files, args.model), retry);
    const path = join(args.records, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    process.stdout.write(`${files.length} 条重组后的用例已交给 Hub 核对\n${text.slice(0, SHOWN_CHARS)}\n${text.length > SHOWN_CHARS ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，请分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
