// Pack check functions for defect-to-case.
import type { CatalogEntry, CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import {
  buildCompactIndex,
  commandSetKey,
  isCompactIndex,
  normalizeCommand,
  normalizeText,
} from './compact-index.ts';
import { extractDrafts } from './subjects.ts';
import { CANONICAL_CATEGORIES, CODES, type CanonicalCategory, type DraftCase } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CATEGORY_MAP: Record<string, CanonicalCategory> = {
  functional: 'Functional',
  function: 'Functional',
  functions: 'Functional',
  func: 'Functional',
  功能: 'Functional',
  功能测试: 'Functional',
  基本功能: 'Functional',
  configuration: 'Configuration',
  configure: 'Configuration',
  config: 'Configuration',
  配置: 'Configuration',
  配置测试: 'Configuration',
  integration: 'Integration',
  integrate: 'Integration',
  集成: 'Integration',
  集成测试: 'Integration',
  compatibility: 'Compatibility',
  compat: 'Compatibility',
  兼容: 'Compatibility',
  兼容性: 'Compatibility',
  negative: 'Negative',
  neg: 'Negative',
  负向: 'Negative',
  反向: 'Negative',
  异常: 'Negative',
  stress: 'Stress',
  pressure: 'Stress',
  压力: 'Stress',
  压测: 'Stress',
};

export function normalizeTag(tag: string): CanonicalCategory | null {
  const norm = normalizeText(tag).replace(/^[\[\(\{【（<]+/, '').replace(/[\]\)\}】）>]+$/, '');
  const direct = CATEGORY_MAP[norm];
  if (direct) return direct;
  for (const [k, v] of Object.entries(CATEGORY_MAP)) {
    if (norm === k || norm.startsWith(k) || norm.endsWith(k)) return v;
  }
  return null;
}

/** Check 1: draft_shape - validates team case structure rules */
export function checkDraftShape(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};
  const slots = subject.slots;

  if (slots === null || slots === undefined) {
    return [
      {
        verdict: 'support',
        statement: '该缺陷已声明跳过，无需起草用例',
        grounds: [],
        tier: 'blocking',
        ...own,
      },
    ];
  }

  const drafts = extractDrafts(slots);

  if (drafts.length === 0) {
    return [
      {
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: '每个缺陷至少需要起草 1 个用例',
        grounds: [],
        tier: 'blocking',
        ...own,
      },
    ];
  }

  const outcomes: CheckOutcome[] = [];
  const seenSignatures = new Set<string>();

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const prefix = `第 ${i + 1} 个起草用例`;

    // Title checks
    if (!draft.title || !draft.title.trim()) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}标题不能为空`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    } else if (draft.title.length > 200) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}标题长度超过 200 字符（当前 ${draft.title.length} 字符）`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    }

    // Step checks
    if (!draft.steps || draft.steps.length === 0) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}缺少执行步骤：至少需要包含一个带命令行的步骤`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    } else {
      const hasCmd = draft.steps.some((s) => s.command && s.command.trim());
      if (!hasCmd) {
        outcomes.push({
          verdict: 'refute',
          code: CODES.SHAPE_INVALID,
          statement: `${prefix}步骤中缺少有效的命令行`,
          grounds: [],
          tier: 'blocking',
          ...own,
        });
      }
    }

    // Expected result checks
    if (!draft.expected || draft.expected.length === 0) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}缺少期望结果：至少需要包含一个期望结果`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    }

    // Priority checks: 1 to 3
    if (typeof draft.priority !== 'number' || !Number.isInteger(draft.priority) || draft.priority < 1 || draft.priority > 3) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}优先级必须是 1 到 3 的整数（当前 ${draft.priority}）`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    }

    // Tags check
    if (!draft.tags || draft.tags.length === 0) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.SHAPE_INVALID,
        statement: `${prefix}缺少标签：至少需要包含一个属于团队模板类别的标签`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    } else {
      let hasNegativeTag = false;
      for (const t of draft.tags) {
        const canonical = normalizeTag(t);
        if (!canonical) {
          outcomes.push({
            verdict: 'refute',
            code: CODES.SHAPE_INVALID,
            statement: `${prefix}标签“${t}”不属于团队模板类别（${CANONICAL_CATEGORIES.join('、')}）`,
            grounds: [],
            tier: 'blocking',
            ...own,
          });
        } else if (canonical === 'Negative') {
          hasNegativeTag = true;
        }
      }
      if (hasNegativeTag && draft.negative !== true) {
        outcomes.push({
          verdict: 'refute',
          code: CODES.SHAPE_INVALID,
          statement: `${prefix}包含反向标签（Negative），但 negative 未标记为 true`,
          grounds: [],
          tier: 'blocking',
          ...own,
        });
      }
    }

    // Duplicate check within submission
    const normTitle = normalizeText(draft.title);
    const normSteps = draft.steps.map((s) => normalizeCommand(s.command)).join(';');
    const sig = `${normTitle}|${normSteps}`;
    if (seenSignatures.has(sig)) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.DUPLICATE_DRAFT,
        statement: `${prefix}“${draft.title}”在同一次提交中重复起草（规范化标题与命令行完全相同）`,
        grounds: [],
        tier: 'blocking',
        ...own,
      });
    }
    seenSignatures.add(sig);
  }

  if (outcomes.length > 0) return outcomes;
  return [
    {
      verdict: 'support',
      statement: `${drafts.length} 个起草用例符合团队用例结构规范`,
      grounds: [],
      tier: 'blocking',
      ...own,
    },
  ];
}

/**
 * The command head of a line: the longest catalog entry whose words head the line's words (NFKC, case-insensitive,
 * whitespace collapsed). Null when no entry heads it — the commands check refutes such a line on its own.
 */
export function commandHeadOf(line: string, catalogEntries: CatalogEntry[]): string | null {
  const words = normalizeCommand(line).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  let best: { head: string; length: number } | null = null;
  for (const entry of catalogEntries) {
    const entryWords = (entry.words ?? []).map((word) => normalizeText(word));
    if (entryWords.length === 0 || entryWords.length > words.length) continue;
    if (!entryWords.every((word, i) => word === words[i])) continue;
    if (best === null || entryWords.length > best.length) best = { head: normalizeCommand(entry.words.join(' ')), length: entryWords.length };
  }
  return best?.head ?? null;
}

/** Helper to match a command against catalog entries */
function matchCatalogCommand(cmdText: string, catalogEntries: CatalogEntry[]): { matched: boolean; head?: string } {
  const norm = normalizeCommand(cmdText);
  const words = norm.split(' ').filter(Boolean);
  if (words.length === 0) return { matched: false };

  for (const entry of catalogEntries) {
    const entryWords = entry.words.map((w) => w.toLowerCase());
    if (words.length < entryWords.length) continue;
    const isPrefix = entryWords.every((w, i) => w === words[i]);
    if (!isPrefix) continue;

    const args = words.slice(entryWords.length);
    const head = entry.words.join(' ');

    if (entry.signatures.length === 0) {
      if (args.length === 0) return { matched: true, head };
      continue;
    }

    for (const sig of entry.signatures) {
      const anySig = sig as Record<string, unknown>;
      const params = (Array.isArray(anySig.params) ? anySig.params : (Array.isArray(anySig.parameters) ? anySig.parameters : [])) as Array<Record<string, unknown>>;
      const requiredParams = params.filter((p) => p.optional !== true);
      if (args.length < requiredParams.length || args.length > params.length) continue;

      let validArgs = true;
      for (let i = 0; i < args.length; i++) {
        const param = params[i];
        const arg = args[i];
        if (!param) break;
        const pType = param.type;
        if (pType === 'int' || pType === 'integer' || pType === 'port') {
          const num = Number(arg);
          if (!Number.isInteger(num)) {
            validArgs = false;
            break;
          }
          const min = typeof param.minimum === 'number' ? param.minimum : (param.range && typeof (param.range as { min?: number }).min === 'number' ? (param.range as { min: number }).min : undefined);
          const max = typeof param.maximum === 'number' ? param.maximum : (param.range && typeof (param.range as { max?: number }).max === 'number' ? (param.range as { max: number }).max : undefined);
          if (min !== undefined && num < min) {
            validArgs = false;
            break;
          }
          if (max !== undefined && num > max) {
            validArgs = false;
            break;
          }
        }
      }
      if (validArgs) return { matched: true, head };
    }
  }
  return { matched: false };
}

/** Check 2: commands_refutation - verifies expects_refutation semantics */
export function checkCommandsRefutation(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};
  const slots = subject.slots;

  if (slots === null || slots === undefined) {
    return [
      {
        verdict: 'support',
        statement: '该缺陷已声明跳过，无命令需要核对',
        grounds: [],
        tier: 'blocking',
        ...own,
      },
    ];
  }

  const drafts = extractDrafts(slots);
  const catalog = Array.isArray(record.catalog) ? (record.catalog as CatalogEntry[]) : [];

  const outcomes: CheckOutcome[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const prefix = `第 ${i + 1} 个起草用例`;

    for (const step of draft.steps) {
      if (!step.command || !step.command.trim()) continue;
      const { matched, head } = matchCatalogCommand(step.command, catalog);

      if (draft.expects_refutation === true && draft.negative === true) {
        if (matched) {
          outcomes.push({
            verdict: 'refute',
            code: CODES.NEGATIVE_ACCEPTED,
            statement: `${prefix}“${draft.title}”声明预期被反驳（expects_refutation 为 true），但命令行“${step.command}”符合目录中“${head ?? '相关命令'}”的签名，未被反驳`,
            grounds: [],
            tier: 'blocking',
            ...own,
          });
        }
      } else if (draft.expects_refutation !== true) {
        if (!matched && catalog.length > 0) {
          outcomes.push({
            verdict: 'refute',
            code: CODES.UNEXPECTED_REFUTATION,
            statement: `${prefix}“${draft.title}”未声明预期被反驳，但命令行“${step.command}”在命令目录中不存在或参数不符合签名`,
            grounds: [],
            tier: 'blocking',
            ...own,
          });
        }
      }
    }
  }

  if (outcomes.length > 0) return outcomes;
  return [
    {
      verdict: 'support',
      statement: '所有起草用例的预期反驳标记与命令目录核对一致',
      grounds: [],
      tier: 'blocking',
      ...own,
    },
  ];
}

/** Fold whitespace as case-compile does; spelling, punctuation and case stay exact. */
function foldQuoteText(text: string): string {
  return text.replace(/[\p{White_Space}]+/gu, ' ').trim();
}

/** Every expected text must be a nonempty verbatim fragment of its own quotation. */
export function checkGroundedReading(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};
  if (subject.slots === null || subject.slots === undefined) return [{ verdict: 'support', statement: '该缺陷已声明跳过，无需核对期望结果引文依据', grounds: [], tier: 'blocking', ...own }];
  const outcomes: CheckOutcome[] = [];
  for (const [i, draft] of extractDrafts(subject.slots).entries()) {
    for (const [j, exp] of draft.expected.entries()) {
      const pointer = `/cases/${i}/expected/${j}/quote`;
      const at = `第 ${i + 1} 个起草用例第 ${j + 1} 个期望结果`;
      if (!exp.quote || !exp.quote.reference || !foldQuoteText(exp.quote.text)) {
        outcomes.push({ verdict: 'refute', code: CODES.QUOTE_MISSING, statement: `${at}（${pointer}）缺少逐字引文（quote）；修正：每个期望结果自带 {"text": "<修复说明或手册里的逐字原文>", "reference": "<引用>"}`, grounds: [], tier: 'blocking', pointer, ...own });
        continue;
      }
      const expected = foldQuoteText(exp.text);
      if (expected === '' || !foldQuoteText(exp.quote.text).includes(expected)) {
        outcomes.push({ verdict: 'refute', code: CODES.EXPECT_NOT_IN_QUOTE, statement: `${at}文字不是所附引文的逐字片段（只忽略空白差异）；修正：从这段修复说明或手册引文逐字摘取非空的期望文字，不得改写，再提交修复`, grounds: [exp.quote.reference], tier: 'blocking', pointer: `/cases/${i}/expected/${j}/text`, ...own });
      }
    }
  }
  return outcomes.length ? outcomes : [{ verdict: 'support', statement: '所有期望结果文字均为各自引文的非空逐字片段（只忽略空白差异）', grounds: [], tier: 'blocking', ...own }];
}

/** Source identity is frozen by projection, never accepted from submitted draft data. */
export function checkQuoteSources(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const own = typeof subject.item === 'string' ? { item: subject.item } : {};
  const allowed = isRecord(subject.allowed_quote_sources) ? subject.allowed_quote_sources : {};
  const quotes = Array.isArray(subject.quotes) ? subject.quotes : [];
  const out: CheckOutcome[] = [];
  const fix = '修正：引用本条缺陷绑定原件的 src:<摘要>/json@1/p/fields/<fix_field>，或 inputs.manual 绑定的同版本线手册 src 片段；tree:/rec: 无法证明来源身份，改引对应原件的 src 片段';
  for (const [index, value] of quotes.entries()) {
    const reference = isRecord(value) && typeof value.reference === 'string' ? value.reference : '';
    let accepted = false;
    const match = /^src:([0-9a-f]{64})(?:\/([^/]+)\/(.+?)(?::[0-9]+-[0-9]+)?)?$/.exec(reference);
    if (match && match[1] === allowed.manual) accepted = true;
    if (match && match[1] === allowed.defect && match[2] === 'json@1') {
      try {
        const parts = match[3].split('/').map((part) => decodeURIComponent(part));
        accepted = parts.length === 3 && parts[0] === 'p' && parts[1] === 'fields' && parts[2] === allowed.fix_field;
      } catch { accepted = false; }
    }
    if (!accepted) out.push({ verdict: 'refute', code: CODES.QUOTE_SOURCE_FORBIDDEN, statement: `第 ${index + 1} 条引文没有指向本条缺陷的配置修复字段或绑定的同版本线手册。${fix}`, grounds: [], tier: 'blocking', pointer: `/quotes/${index}/reference`, ...own });
  }
  return out.length ? out : [{ verdict: 'support', statement: '各引文来源均为本条缺陷的配置修复说明字段或绑定的同版本线手册', grounds: [], tier: 'blocking', ...own }];
}

/** Check 4: checkDuplicate - verifies drafts do not duplicate indexed cases */
export function checkDuplicate(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};
  const catalog = Array.isArray(record.catalog) ? (record.catalog as CatalogEntry[]) : [];

  // Drafts can come from subject.drafts or extractDrafts(subject.slots)
  const drafts: DraftCase[] = Array.isArray(subject.drafts) ? (subject.drafts as DraftCase[]) : extractDrafts(subject.slots);

  if (!subject.indexed_cases) {
    return [
      {
        verdict: 'unknown',
        reason: 'missing_input',
        statement: '没有绑定用例索引（indexed_cases），无法核对重复用例',
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  if (drafts.length === 0) {
    return [
      {
        verdict: 'support',
        statement: '该缺陷无起草用例（已声明跳过），无需去重',
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  const compactIndex = isCompactIndex(subject.indexed_cases)
    ? subject.indexed_cases
    : buildCompactIndex(subject.indexed_cases);

  const outcomes: CheckOutcome[] = [];
  const buckets = compactIndex.by_commands ?? {};

  // Every draft command line resolves to its head first (the longest catalog entry heading it); the narrowing
  // judgment and the buckets are by head sets. A line with no head is refuted by the commands check on its own;
  // here the draft is unknown with the reason named.
  const unresolved = new Map<unknown, string>();
  const headSets = new Map<unknown, string[]>();
  for (const draft of drafts) {
    const lines = draft.steps.map((s) => s.command).filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    const heads: string[] = [];
    for (const line of lines) {
      const head = commandHeadOf(line, catalog);
      if (head === null) {
        unresolved.set(draft, line);
        break;
      }
      heads.push(head);
    }
    if (!unresolved.has(draft)) headSets.set(draft, heads);
  }
  for (const [draft, line] of unresolved) {
    const title = (draft as { title?: string }).title ?? '（无标题）';
    outcomes.push({
      verdict: 'unknown',
      reason: 'missing_input',
      statement: `起草用例“${title}”的命令行“${line}”在锁定构建的命令目录里解析不出命令头，无法核对重复（命令检查已另行驳回它）`,
      grounds: [],
      tier: 'advisory',
      ...own,
    });
  }

  // The narrowed keys (only=…), normalized the same way as the bucket keys. Null: the view is complete (no narrowing).
  // A hand-built compact index may predate the field; undefined means un-narrowed.
  const only = compactIndex.only ?? null;
  const missingKeys = compactIndex.missingKeys ?? [];
  if (only !== null && (missingKeys.length > 0 || compactIndex.sourceTruncated === true)) {
    const detail = [
      ...(missingKeys.length > 0 ? [`源视图缺少请求的键：${missingKeys.join('、')}，请重新读取这些键`] : []),
      ...(compactIndex.sourceTruncated === true ? ['收窄的源视图已截断，无法证明请求键的覆盖完整，请重新读取未截断视图'] : []),
    ].join('；');
    return [...outcomes, { verdict: 'unknown', reason: 'integrity_unproven', statement: `${detail}，无法核对重复`, grounds: [], tier: 'advisory', ...own, data: { missing_keys: missingKeys } }];
  }
  const capped = new Set((compactIndex.cappedKeys ?? []).map(normalizeCommand));
  // Decidable: some key of the draft's command set sits in only AND is not cut. cut_keys is authoritative;
  // for older views only, a key at the per-key cap is possibly cut. An intersection entirely on such keys stays unknown.
  const keyState = (cmds: readonly string[]): { covered: boolean; onlyCapped: boolean } => {
    const normalized = [...new Set(cmds.map(normalizeCommand).filter((c) => c !== ''))];
    if (normalized.length === 0) return { covered: only === null, onlyCapped: false };
    const inOnly = only === null ? normalized : normalized.filter((c) => only.some((k) => normalizeCommand(k) === c));
    if (inOnly.length === 0) return { covered: false, onlyCapped: false };
    return { covered: true, onlyCapped: inOnly.every((c) => capped.has(c)) };
  };
  const undecidable = new Set<unknown>();
  const cappedOnly = new Set<unknown>();
  for (const draft of headSets.keys()) {
    const state = keyState(headSets.get(draft) ?? []);
    if (!state.covered) undecidable.add(draft);
    else if (state.onlyCapped) cappedOnly.add(draft);
  }

  for (const draft of headSets.keys()) {
    const heads = headSets.get(draft) ?? [];
    const draftKey = commandSetKey(heads);
    if (!draftKey) continue;
    if (undecidable.has(draft)) continue;

    const candidates = buckets[draftKey];
    if (!candidates || candidates.length === 0) continue;

    const draftTitle = normalizeText((draft as { title?: string }).title ?? '');

    for (const cand of candidates) {
      // 1. Same negative flag
      const candNegative = cand.negative === true;
      if ((draft as { negative?: boolean }).negative === true !== candNegative) continue;

      // Case entries carry no expected-text field (the index fields are commands,document,node,title,negative): the
      // comparison is the normalised title (plus the negative flag above and the command-set key that picked the bucket).
      const candTitle = normalizeText(cand.title);
      const titlesEqual = draftTitle === candTitle && draftTitle !== '';

      if (titlesEqual) {
        const doc = cand.document || '未知文档';
        const node = cand.node || '未知节点';
        const title = cand.title || '未知标题';
        outcomes.push({
          verdict: 'refute',
          code: CODES.DUPLICATE_CASE,
          statement: `起草用例“${(draft as { title?: string }).title ?? '（无标题）'}”与已索引用例重复：文档 ${doc} 节点 ${node}“${title}”（${cand.reference}）`,
          grounds: [cand.reference],
          tier: 'advisory',
          ...own,
          data: {
            duplicate_of: {
              document: doc,
              node,
              title,
              reference: cand.reference,
            },
          },
        });
      }
    }
  }

  // A draft outside the narrowing is unknown on its own (the index does not cover its commands).
  if (undecidable.size > 0) {
    const sample = [...undecidable][0] as { title?: string };
    const cmds = (headSets.get(sample) ?? []).join('、');
    outcomes.push({
      verdict: 'unknown',
      reason: 'missing_input',
      statement: `起草用例“${sample.title ?? '（无标题）'}”用的命令（${cmds}）不在索引收窄的命令里，索引没有收窄到它用的命令，无法核对重复`,
      grounds: [],
      tier: 'advisory',
      ...own,
    });
  }
  // An intersection entirely on cut or possibly-cut keys cannot prove absence of duplicates.
  if (cappedOnly.size > 0) {
    const sample = [...cappedOnly][0] as { title?: string };
    outcomes.push({
      verdict: 'unknown',
      reason: 'integrity_unproven',
      statement: `起草用例“${sample.title ?? '（无标题）'}”的命令所在键受每键上限影响，已截断或无法证明未截断，无法断定未重复`,
      grounds: [],
      tier: 'advisory',
      ...own,
    });
  }
  if (outcomes.length > 0) return outcomes;

  // Entries without a commands field: their command sets are unknown, "no duplicate" cannot be claimed for them.
  if ((compactIndex.unplacedCommands ?? 0) > 0) {
    return [
      {
        verdict: 'unknown',
        reason: 'integrity_unproven',
        statement: `未发现重复用例，但索引里有 ${compactIndex.unplacedCommands} 个条目没有带 commands 字段，无法断定未重复`,
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  // No duplicate found: check if index has dropped cases or is incomplete
  if (!compactIndex.complete || compactIndex.dropped > 0) {
    let reasonText = '';
    if (compactIndex.dropped > 0) {
      reasonText = `用例索引超出大小上限截断丢弃了 ${compactIndex.dropped} 个用例`;
    } else {
      const skippedSources = isRecord(subject.indexed_cases) && typeof subject.indexed_cases.skipped === 'number'
        ? subject.indexed_cases.skipped
        : 0;
      if (skippedSources > 0) {
        reasonText = `用例索引缺少 ${skippedSources} 份列出的文档`;
      } else {
        reasonText = '用例索引不完整';
      }
    }
    return [
      {
        verdict: 'unknown',
        reason: 'integrity_unproven',
        statement: `未发现重复用例，但${reasonText}，无法断定未重复`,
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  // Also check if raw index had skipped sources
  const rawSkipped = isRecord(subject.indexed_cases) && typeof subject.indexed_cases.skipped === 'number'
    ? subject.indexed_cases.skipped
    : 0;
  if (rawSkipped > 0) {
    return [
      {
        verdict: 'unknown',
        reason: 'integrity_unproven',
        statement: `未发现重复用例，但用例索引缺少 ${rawSkipped} 份列出的文档，无法断定未重复`,
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  return [
    {
      verdict: 'support',
      statement: '未发现与已索引用例重复的起草用例',
      grounds: [],
      tier: 'advisory',
      ...own,
    },
  ];
}
