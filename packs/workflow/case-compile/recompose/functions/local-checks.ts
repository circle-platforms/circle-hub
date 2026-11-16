// The Hub's checks of a records submission, run on what download-run.ts saved (round 33: check-record said ok, the Hub refused).
// The Hub builds the input of every check of this pack (checks.json) from the frozen run record, the locked command tree and
// the submission, then calls the check functions the pack names. This module builds the same input from run.json and
// knowledge/nodes.jsonl and calls the very functions checks.json names, so what the Hub would refuse is refused here with the
// same words. It adds no rule of its own: the rules are in those functions. A declared check this module has no wiring for, and
// a core interpreter (quote@1, which exists only inside the Hub), are reported as not run, never as passed.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandTokens } from './generated/skills/command-tools/command-check/grammar.ts';
import { checkRecomposition } from './recompose-check.ts';
import { shapeIssues } from './record-shape.ts';
import seal from './seal.ts';
import { selectCatalog, subject as recordSubject } from './subject.ts';
import { CallFailure, isRecord } from './text.ts';
import { isVerdict } from './generated/vocabulary.ts';

type Row = { [key: string]: any };

/** The pack directory this module belongs to: the one whose checks.json the Hub runs. */
export const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));

const MAX_KNOWLEDGE_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------- locked command tree

/** The nodes of knowledge/nodes.jsonl by path, as the Hub's run export writes them. */
export type KnowledgeNodes = ReadonlyMap<string, Row>;

/** Reads the locked tree saved beside run.json, and refuses one that is not the tree of this run's locked root. */
export async function readKnowledgeNodes(runDir: string, run: Row): Promise<KnowledgeNodes> {
  const file = join(runDir, 'knowledge', 'nodes.jsonl');
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error)));
  if (info === null) {
    throw new CallFailure('not_found', `找不到命令树 ${file}：Hub 用本次运行锁定的命令树核对改写后的命令，没有它就不是 Hub 看到的同一份输入`, '用 download-run.ts 重新下载完整运行目录（含 knowledge/nodes.jsonl）后，再用 --run 指定它', { path: file });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new CallFailure('invalid_parameters', `命令树 ${file} 不是普通文件`, '用 download-run.ts 重新下载完整运行目录，不用符号链接或目录代替', { path: file });
  }
  if (info.size > MAX_KNOWLEDGE_BYTES) {
    throw new CallFailure('invalid_parameters', `命令树 ${file} 超过 512 MiB 上限（实际 ${info.size} 字节）`, '重新下载本次运行的完整命令树；仍超限时请维护者核对运行导出', { path: file });
  }
  const rows: unknown[] = [];
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) if (line !== '') rows.push(JSON.parse(line));
  } catch {
    throw new CallFailure('invalid_parameters', `命令树 ${file} 不是逐行 JSON`, '重新下载本次运行完整的 knowledge/nodes.jsonl', { path: file });
  }
  const [head, ...nodes] = rows;
  if (!isRecord(head) || head.schema !== 'run-knowledge@1' || head.run !== run.run || head.root !== run.root || head.nodes !== nodes.length) {
    const named = isRecord(head) ? `运行 ${String(head.run)}、根 ${String(head.root)}、${String(head.nodes)} 个节点` : '没有首行';
    throw new CallFailure('invalid_parameters', `命令树 ${file} 不是运行 ${String(run.run)} 锁定根 ${String(run.root)} 的完整下载（它写的是${named}，实际 ${nodes.length} 行）`, '重新下载本次运行完整的 knowledge/nodes.jsonl，不拼接其他运行的命令树', { path: file });
  }
  return new Map(nodes.filter(isRecord).filter((node) => typeof node.path === 'string').map((node) => [node.path as string, node]));
}

/**
 * The catalog data of a definition as the Hub reads it (hub/knowledge/produce.ts catalogData: catalog-entry@1): the head words, and
 * the overloads, which a definition without any takes as none (a command without arguments). Null when it is not catalog data.
 */
function catalogData(data: unknown): { words: string[]; signatures: Row[] } | null {
  if (!isRecord(data) || !Array.isArray(data.words) || data.words.length === 0 || data.words.some((word) => typeof word !== 'string' || word.length === 0)) return null;
  const signatures = data.signatures ?? [];
  if (!Array.isArray(signatures) || signatures.some((signature) => !isRecord(signature) || !Array.isArray(signature.params) || Object.keys(signature).some((key) => !['id', 'params', 'reference', 'access'].includes(key)))) return null;
  return { words: data.words as string[], signatures };
}

const SELECTION_ERROR = '目录选择必须声明路径和至多 128 条完整命令，每条至多 8192 字节；拆分计划后重核';
const UNREADABLE_PATH = '缺锁定目录的所选路径；管理员修复目录读取后原样重交，不用整棵目录代替';

/**
 * The catalog entries the Hub hands the `record` check for one item: its `catalog_select` names a base and complete command
 * lines, and the Hub follows only exact edges of the locked tree from the words of each line and takes the definitions at the
 * nodes it passes (hub/knowledge/catalog-selection.ts). The same walk over the saved nodes, with the same limits and words.
 * Returns the entries or the reason the Hub gives when the selection cannot be read.
 */
export function selectedCatalog(nodes: KnowledgeNodes, selection: unknown): { entries: Row[] } | { missing: string } {
  if (!isRecord(selection) || typeof selection.base !== 'string' || !Array.isArray(selection.lines) || selection.lines.length > 128
    || selection.lines.some((line) => typeof line !== 'string' || Buffer.byteLength(line) > 8192)) return { missing: SELECTION_ERROR };
  const start = nodes.get(selection.base);
  const selected = new Map<string, Row>();
  const passed = new Set<string>();
  for (const line of new Set(selection.lines as string[])) {
    const tokens = commandTokens(line);
    if (!tokens) continue;
    if (tokens.length > 128) return { missing: '单条命令超过 128 个语法令牌；拆分计划后重核' };
    let current = start;
    for (const token of tokens) {
      if (!current || token.quoted) break;
      const edge = (current.children as Row[] | undefined)?.find((child) => child.name === token.value);
      if (!edge) break;
      const next = nodes.get(edge.path);
      if (next === undefined) return { missing: UNREADABLE_PATH };
      current = next;
      if (Array.isArray(next.entries) && next.entries.length > 0) passed.add(next.path);
    }
  }
  let bytes = 0;
  for (const path of passed) {
    const kept = (nodes.get(path)!.entries as Row[]).filter((row) => row.kind === 'definition');
    if (selected.size + kept.length > 512) return { missing: '所选路径超过 512 个目录条目；拆分计划后重核' };
    for (const row of kept) {
      const data = catalogData(row.data);
      if (data === null) continue;
      const entry = { words: data.words, signatures: data.signatures, reference: row.reference };
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > 1024 * 1024) return { missing: '所选目录超过 1 MiB；拆分计划后重核' };
      selected.set(path + '@' + row.entry, entry);
    }
  }
  // The view merges the overloads of one head into one entry and lists the heads in order.
  const merged = new Map<string, Row>();
  for (const entry of selected.values()) {
    const words = (entry.words as string[]).map((word) => word.normalize('NFC'));
    const key = words.join('\0');
    const same = merged.get(key);
    if (same) same.signatures.push(...entry.signatures);
    else merged.set(key, { ...entry, words, signatures: [...entry.signatures] });
  }
  const head = (entry: Row) => (entry.words as string[]).join(' ');
  return { entries: [...merged.values()].sort((a, b) => (head(a) < head(b) ? -1 : head(a) > head(b) ? 1 : 0)) };
}

// ------------------------------------------------------------------------------------------------- inputs of the Hub's checks

/** The names of the product line the run locked, as its target basis froze them (evaluate.ts productNamesOf). */
const productNamesOf = (run: Row): string[] => {
  for (const claim of Array.isArray(run.target_basis) ? run.target_basis : []) {
    const data = claim?.statement?.data;
    if (data?.field === 'product' && Array.isArray(data.names)) return data.names.filter((name: unknown) => typeof name === 'string');
  }
  return [];
};

/** The facts about a run the checks may use, from the frozen run record alone (evaluate.ts runContextOf, without leases). */
export function frozenContext(run: Row): Row {
  return {
    run: run.run,
    predecessor: run.predecessor ?? null,
    ...(run.product_pack_digest ? { product_pack_digest: run.product_pack_digest } : {}),
    ...(run.skills !== undefined ? { skills: run.skills } : {}),
    ...(run.command_policy ? { command_policy: run.command_policy } : {}),
    ...(run.feeding_offset ? { feeding_offset: run.feeding_offset } : {}),
    product: run.product ?? null,
    names: productNamesOf(run),
    line: run.version ?? null,
    build: run.build ?? null,
    root: run.root ?? null,
    parameters: run.parameters,
    groups: run.groups ?? [],
    ...(run.builds !== undefined ? { builds: run.builds } : {}),
  };
}

/**
 * The resolved evidence the Hub gives the checks of one item: a row for each distinct reference the slot record quotes. The
 * record the tool builds quotes the case's own original sentences, so each fragment is the node of the frozen item, whose text
 * is the sentences cut from it in order.
 */
export function frozenEvidence(item: Row, slots: Row): Row[] {
  const parts = new Map<string, Array<{ start: number; text: string }>>();
  for (const atom of Array.isArray(item.fields?.atoms) ? item.fields.atoms : []) {
    if (typeof atom?.reference !== 'string' || typeof atom.text !== 'string') continue;
    parts.set(atom.reference, [...(parts.get(atom.reference) ?? []), { start: Number(atom.start) || 0, text: atom.text }]);
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const claim of Array.isArray(slots.record) ? slots.record : []) {
    for (const quote of Array.isArray(claim?.quotes) ? claim.quotes : []) {
      const found = parts.get(quote?.reference);
      if (!found || seen.has(quote.reference)) continue;
      seen.add(quote.reference);
      rows.push({ reference: quote.reference, resolved: true, source: null, role: 'subject', text: found.sort((a, b) => a.start - b.start).map((part) => part.text).join('') });
    }
  }
  return rows;
}

// ------------------------------------------------------------------------------------------- what the Hub does with an output

const OUTCOME_KEYS = ['missing', 'exit', 'verdict', 'code', 'statement', 'grounds', 'tier', 'reason', 'item', 'pointer', 'data', 'judgment_sources'];
/** The part of check-outcome@1 (contracts/src/tables.ts) that decides whether the Hub takes an output at all: strict keys, the three verdicts, a statement, and for an unknown its missing fact and reason. */
const outcomeShape = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).every((key) => OUTCOME_KEYS.includes(key))
  && isVerdict(value.verdict) && value.verdict !== 'abstain'
  && typeof value.statement === 'string' && value.statement.length > 0 && Array.isArray(value.grounds) && typeof value.tier === 'string'
  && (value.code === undefined || (typeof value.code === 'string' && value.code.length > 0))
  && (value.verdict !== 'unknown' || (value.missing !== undefined && value.reason !== undefined));

/** Why the Hub replaces a pack function's whole output (hub/rules/check.ts outcomeProblems): the structural cases of it. */
function outputProblem(outcomes: Row[], pack: string): string | undefined {
  for (const [index, outcome] of outcomes.entries()) {
    const at = `第 ${index + 1} 项`;
    if (outcome.verdict === 'refute' && outcome.code === undefined) return `${at}是反驳却没有码`;
    if (outcome.verdict !== 'refute' && outcome.code !== undefined) return `${at}不是反驳却带了码 ${outcome.code}`;
    if (outcome.verdict === 'unknown' && (typeof outcome.missing !== 'string' || !outcome.missing.trim())) return `${at}是未知却没有顶层 missing`;
    if (outcome.verdict !== 'unknown' && outcome.reason !== undefined) return `${at}不是未知却带了原因 ${outcome.reason}`;
    if (outcome.code !== undefined) {
      if (outcome.code.startsWith('core.')) return `${at}的码 ${outcome.code} 属于核心解释器或协议，包内函数不能给出`;
      if (!outcome.code.startsWith(`${pack}.`) || outcome.code.length <= pack.length + 1) return `${at}的码 ${outcome.code} 不在包命名空间 ${pack}. 下`;
    }
  }
  return undefined;
}

/** What the Hub makes of a function's output: the output itself, or one unknown naming why it could not take it. */
export function hubOutcomes(name: string, output: unknown, pack: string): Row[] {
  const refused = (detail: string): Row[] => [{ verdict: 'unknown', reason: 'check_error', missing: detail, statement: detail, grounds: [], tier: 'blocking' }];
  if (!Array.isArray(output) || output.length > 10_000 || !output.every(outcomeShape)) return refused(`包内函数 ${name} 的输出不是 check-outcome@1 数组`);
  const problem = outputProblem(output, pack);
  if (problem !== undefined) return refused(`包内函数 ${name} 的输出无效：${problem}`);
  if (output.length === 0) return refused(`包内函数 ${name} 没有给出结果`);
  return output;
}

// ------------------------------------------------------------------------------------------------------- running the checks

export interface CheckedOutcome {
  /** The check of checks.json that gave the outcome. */
  check: string;
  /** The frozen item it is about; null for a run-level check. */
  item: string | null;
  outcome: Row;
}

export interface LocalChecksResult {
  /** Ids of the checks run here, in the order checks.json declares them. */
  checks: string[];
  /** The structure checks of the slots file the Hub runs before any check, as run here. */
  structure: string[];
  /** The declared checks that were not run, each with the reason. */
  not_run: Array<{ check: string; why: string }>;
  outcomes: CheckedOutcome[];
}

export interface LocalChecksInput {
  run: Row;
  nodes: KnowledgeNodes;
  /** The handled items of the submission as the Hub receives them: the item id and its slot record. */
  items: ReadonlyArray<{ item: string; slots: Row }>;
  /** Whether every frozen item is among `items`, so the run-level checks have their whole subject; else why they have not. */
  complete: true | string;
  packDir?: string;
}

const subjectItem = (item: Row): Row => ({ id: item.id, label: item.label, location: item.location, fields: item.fields });
/** Where the model writes what the record keeps at a place: the lite file of submit-records.ts, field by field. */
const LITE_FIELD: ReadonlyArray<readonly [string, string]> = [
  ['/contract/method', 'method'],
  ['/expectation_slots', 'slots'],
  ['/sources/states', 'states'],
  ['/sources/candidates', 'candidates'],
  ['/ledgers/adapted', 'adapted'],
  ['/ledgers/concretizations', 'concretizations'],
  ['/unknowns', 'unknowns'],
];
/** What the Hub's sandbox hands a function: the same data after one JSON round trip, without values JSON cannot carry. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * The functions of this pack's checks.json, by the module and export the declaration names. A pack cannot import a module by a
 * computed name, so each is imported here once; a declaration that names another function has no entry and is reported as not run.
 */
const WIRED: Readonly<Record<string, (input: any) => unknown>> = {
  'functions/recompose-check.ts#checkRecomposition': checkRecomposition,
  'functions/subject.ts#subject': recordSubject,
  'functions/subject.ts#selectCatalog': selectCatalog,
  'functions/seal.ts#default': seal,
};
const wiredFunction = (target: { module: string; export?: string }): ((input: any) => unknown) | undefined => WIRED[`${target.module}#${target.export ?? 'default'}`];
const named = (target: { module: string; export?: string }): string => `${target.module} 的 ${target.export ?? 'default'}`;

async function call(target: { module: string; export?: string }, input: unknown): Promise<unknown> {
  const run = wiredFunction(target);
  if (run === undefined) throw new TypeError(`${named(target)} 没有接入本地检查`);
  return await run(wire(input));
}

/** The functions a declared function check needs (its check, its subject, its catalog selection) that have no wiring here. */
const unwired = (check: Row): string[] => [check.function, check.subject, check.catalog_select].filter((target) => target !== undefined && wiredFunction(target) === undefined).map(named);

/**
 * Runs the function checks of the pack's checks.json on the submission the way the Hub's evaluation does: an item check once
 * for each handled item with the subject its `subject` declaration builds from the item, its slot record, its evidence, the run
 * context and the selected catalog; a run check once with every item. Whatever the pack declares and is not a function check is
 * reported as not run, with the reason.
 */
export async function runLocalChecks(input: LocalChecksInput): Promise<LocalChecksResult> {
  const packDir = input.packDir ?? PACK_DIR;
  const declared: Row[] = JSON.parse(await readFile(join(packDir, 'checks.json'), 'utf8')).checks;
  const requirements: Row[] = JSON.parse(await readFile(join(packDir, 'requirements.json'), 'utf8')).requirements;
  const pack: string = JSON.parse(await readFile(join(packDir, 'pack.json'), 'utf8')).id;
  const context = frozenContext(input.run);
  const frozen = new Map<string, Row>((input.run.items as Row[]).map((item) => [item.id, item]));
  const result: LocalChecksResult = { checks: [], structure: [], not_run: [], outcomes: [] };
  const checkInput = (check: Row, subject: unknown, catalog?: Row[]): Row => ({
    check: check.id,
    table: null,
    subject,
    context: { run: input.run.run, requirement: requirements.find((row) => Array.isArray(row.checks) && row.checks.includes(check.id))?.key, pack, sets: {} },
    sources: {},
    unread_sources: [],
    ...(catalog !== undefined ? { catalog } : {}),
  });
  const guarded = async (check: Row, run: () => Promise<unknown>): Promise<Row[]> => {
    try {
      return hubOutcomes(check.id, await run(), pack);
    } catch (error) {
      const own = error instanceof TypeError || error instanceof RangeError;
      const detail = own ? `包内函数 ${check.id} 无法运行：${error.message}` : `包内函数 ${check.id} 无法运行（内部错误）`;
      return [{ verdict: 'unknown', reason: 'check_error', missing: detail, statement: detail, grounds: [], tier: 'blocking' }];
    }
  };

  // The Hub refuses a slot record whose data does not fit the pack's slots.schema.json before it runs any check, and runs no check
  // on that item (evaluate.ts exclude); the same schema is read here.
  const declaredSlots: Row = JSON.parse(await readFile(join(packDir, 'slots.schema.json'), 'utf8')).item ?? {};
  const refused = new Set<string>();
  for (const [key, declaration] of Object.entries(declaredSlots)) {
    if (!isRecord(declaration) || declaration.data === undefined) continue;
    result.structure.push(`slots.schema.json 里要求项 ${key} 的 data 形状`);
    for (const entry of input.items) {
      for (const [index, claim] of (Array.isArray(entry.slots[key]) ? entry.slots[key] : []).entries()) {
        for (const issue of shapeIssues(declaration.data, claim?.data ?? {})) {
          refused.add(entry.item);
          const field = LITE_FIELD.find(([prefix]) => issue.pointer === prefix || issue.pointer.startsWith(prefix + '/'));
          const where = field ? `${field[1]}（记录里的 ${issue.pointer}）` : issue.pointer === '' ? '整条记录' : `记录里的 ${issue.pointer}`;
          const statement = `${where}：${issue.found}；任务包声明的形状要的是 ${issue.expected}；改成允许的写法后重新自检`;
          result.outcomes.push({ check: 'slots', item: entry.item, outcome: { verdict: 'refute', code: 'SUBMISSION_SCHEMA_VIOLATION', statement, grounds: [], tier: 'blocking', pointer: `/slots/${key}/${index}/data${issue.pointer}` } });
        }
      }
    }
  }
  const checked = input.items.filter((entry) => !refused.has(entry.item));

  for (const check of declared) {
    if (check.function === undefined) {
      result.not_run.push({ check: check.id, why: `核心解释器 ${check.interpreter} 只在 Hub 里运行，本地没有它；它核对每段引文是否逐字出现在所引片段里。交给 Hub 的引文只取自下载里冻结的原句，record 检查另核对记录里的原句逐字等于它们` });
      continue;
    }
    const missing = unwired(check);
    if (missing.length > 0) {
      result.not_run.push({ check: check.id, why: `它用到的 ${missing.join('、')} 没有接入本地检查，本地不能代 Hub 运行它；先把它接入 functions/local-checks.ts` });
      continue;
    }
    if (check.applies === 'item') {
      if (check.catalog !== undefined && check.catalog_select === undefined) {
        result.not_run.push({ check: check.id, why: '它读整份目录而不是按条目选取，本地的命令树下载没有按 Hub 的整份目录视图建好，不能冒充' });
        continue;
      }
      for (const entry of checked) {
        const item = frozen.get(entry.item);
        if (item === undefined) continue;
        const raw = { applies: 'item', item: subjectItem(item), slots: entry.slots, evidence: frozenEvidence(item, entry.slots), context };
        let built: Row = raw;
        let catalog: Row[] | undefined;
        if (check.catalog !== undefined) {
          // evaluate.ts builderInput: a selection that cannot be read leaves no catalog, not complete, with the reason.
          let selected: ReturnType<typeof selectedCatalog>;
          try {
            selected = selectedCatalog(input.nodes, await call(check.catalog_select, raw));
          } catch {
            selected = { missing: UNREADABLE_PATH };
          }
          catalog = 'entries' in selected ? selected.entries : [];
          // The download carries no declaration of whether the product's catalog is complete: the Hub's own answer is not known.
          built = { ...raw, catalog, catalog_complete: 'entries' in selected, ...('missing' in selected ? { catalog_missing: selected.missing } : {}) };
        }
        const outcomes = await guarded(check, async () => {
          const subject = check.subject !== undefined ? await call(check.subject, built) : { item: item.id, label: item.label, location: item.location, fields: item.fields, slots: entry.slots, evidence: raw.evidence };
          return await call(check.function, checkInput(check, subject, catalog));
        });
        for (const outcome of outcomes) result.outcomes.push({ check: check.id, item: entry.item, outcome });
      }
      result.checks.push(check.id);
    } else if (check.applies === 'run') {
      if (input.complete !== true || refused.size > 0) {
        result.not_run.push({ check: check.id, why: input.complete !== true ? input.complete : '还有记录没有通过任务包声明的形状检查，整批封批无从核对' });
        continue;
      }
      const targets = requirements.filter((row) => Array.isArray(row.checks) && row.checks.includes(check.id));
      if (targets.some((row) => row.target === 'item')) {
        result.not_run.push({ check: check.id, why: '它是对条目要求项的整批检查，本地只核对目标是整批的整批检查' });
        continue;
      }
      const bySlots = new Map(input.items.map((entry) => [entry.item, entry.slots]));
      const outcomes = await guarded(check, async () => {
        const subject = check.subject !== undefined
          ? await call(check.subject, { applies: 'run', items: (input.run.items as Row[]).map(subjectItem), context })
          : { items: (input.run.items as Row[]).map((item) => ({ ...subjectItem(item), ...(bySlots.has(item.id) ? { slots: bySlots.get(item.id) } : {}) })), cross_item: [] };
        return await call(check.function, checkInput(check, subject));
      });
      for (const outcome of outcomes) result.outcomes.push({ check: check.id, item: typeof outcome.item === 'string' ? outcome.item : null, outcome });
      result.checks.push(check.id);
    } else {
      result.not_run.push({ check: check.id, why: `它的作用范围 ${String(check.applies)} 本地不认识` });
    }
  }
  return result;
}
