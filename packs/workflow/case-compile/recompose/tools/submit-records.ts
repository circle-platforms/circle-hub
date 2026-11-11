// Recomposition, one file per case. The model writes only what takes judgment: the method, what it adapted, what it made
// concrete and what is missing. Everything the projection already knows (the atoms, their spans, the original ledger, the
// coverage) is filled in here, as InfoTest's fill_mechanical_fields does, so a model never retypes author text. It decides
// nothing: the Hub checks every record, and a file that says nothing about an atom leaves that atom settled.
//   node <skill directory>/tools/submit-records.ts --hub %HUB_URL% --run <run id> --model <model> --records <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, bearerFrom, get, hubOrigin, itemFiles, RUN_ID, submitResult, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

const SHOWN_CHARS = 12_000;
type Row = { [key: string]: any };
const list = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];

/** The exit a state carries when the model names none: the case goes on to the writer. */
const onward = (atom: string) => ({ action: '进入编写', object: atom, owner: '编写模型', due: '编写提交之前' });

/** The complete recompose-record@1 of one case: the frozen item plus the model's file. */
export function recordFor(item: Row, file: Row, model: string): Row {
  const fields = item.fields ?? {}, atoms = list(fields.atoms);
  const named = [fields.case_id, atoms.find((a) => a.kind === 'intent')?.text].filter(Boolean).join(' ') || '编号和标题未知';
  const atom = (id: unknown) => atoms.find((a) => a.id === id);
  const quote = (a: Row | undefined) => a === undefined ? undefined : { text: a.text, quote_ref: a.reference, verbatim: true };
  if (file.method === undefined) throw new Error(`原始用例 ${named} 缺少用例重组的方法，请补齐后再做用例重组`);
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

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'records']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const files = await itemFiles(args.records, (value) => value.handling === undefined ? { ...value, handling: 'handled' } : value);
    const bearer = await bearerFrom(readToken);
    const exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(`${origin}/run-export/${args.run}/run`, bearer)));
    if (exported?.schema !== 'run-export@1' || exported.run?.run !== args.run) throw new Error('Hub 返回的原始用例不完整');
    const { text, failed } = await submitResult(origin, bearer, submissionFor(exported.run, files, args.model));
    const path = join(args.records, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    process.stdout.write(`${files.length} 条重组后的用例已交给 Hub 核对\n${text.slice(0, SHOWN_CHARS)}\n${text.length > SHOWN_CHARS ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，请分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(`用例重组未完成：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
