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

const ON_OFF_TERMS = ['开启', '关闭', '使能', '禁用', '启用', '停用', '正常', '异常', 'on', 'off', 'enable', 'disable', 'enabled', 'disabled', 'up', 'down'];

/** Check 3: grounded_reading - verifies expected text has quotation and introduces no unsupported entities */
export function checkGroundedReading(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};
  const slots = subject.slots;

  if (slots === null || slots === undefined) {
    return [
      {
        verdict: 'support',
        statement: '该缺陷已声明跳过，无需核对期望结果引文依据',
        grounds: [],
        tier: 'advisory',
        ...own,
      },
    ];
  }

  const drafts = extractDrafts(slots);

  const outcomes: CheckOutcome[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const prefix = `第 ${i + 1} 个起草用例`;

    for (let j = 0; j < draft.expected.length; j++) {
      const exp = draft.expected[j];
      const at = `${prefix}第 ${j + 1} 个期望结果`;

      if (!exp.quote || !exp.quote.reference || !exp.quote.text || !exp.quote.text.trim()) {
        outcomes.push({
          verdict: 'refute',
          code: CODES.QUOTE_MISSING,
          statement: `${at}缺少逐字引文（quote）：每个期望结果必须提供所引用的原文及引用地址`,
          grounds: [],
          tier: 'blocking',
          ...own,
        });
        continue;
      }

      const quoteText = exp.quote.text;
      const expectedText = exp.text;

      // Extract numbers from expectedText that are not in quoteText
      const expNumbers = expectedText.match(/\b\d+\b/g) ?? [];
      const quoteNumbers = new Set(quoteText.match(/\b\d+\b/g) ?? []);
      for (const num of expNumbers) {
        if (!quoteNumbers.has(num)) {
          outcomes.push({
            verdict: 'refute',
            code: CODES.UNSUPPORTED_ENTITY,
            statement: `${at}文字中包含数字“${num}”，但所附引文中未包含此数字`,
            grounds: [exp.quote.reference],
            tier: 'advisory',
            ...own,
          });
          break;
        }
      }

      // Extract on/off state terms from expectedText that are not in quoteText
      for (const term of ON_OFF_TERMS) {
        if (expectedText.toLowerCase().includes(term) && !quoteText.toLowerCase().includes(term)) {
          outcomes.push({
            verdict: 'refute',
            code: CODES.UNSUPPORTED_ENTITY,
            statement: `${at}文字中包含状态词“${term}”，但所附引文中未包含该状态词`,
            grounds: [exp.quote.reference],
            tier: 'advisory',
            ...own,
          });
          break;
        }
      }
    }
  }

  if (outcomes.length > 0) return outcomes;
  return [
    {
      verdict: 'support',
      statement: '所有期望结果均具有对应引文依据，未引入无原文依据的数字、命令或开关状态',
      grounds: [],
      tier: 'advisory',
      ...own,
    },
  ];
}

/** Check 4: checkDuplicate - verifies drafts do not duplicate indexed cases */
export function checkDuplicate(input: unknown): CheckOutcome[] {
  const record = isRecord(input) ? input : {};
  const subject = isRecord(record.subject) ? record.subject : record;
  const itemId = typeof subject.item === 'string' ? subject.item : undefined;
  const own = itemId !== undefined ? { item: itemId } : {};

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

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const draftCmds = draft.steps.map((s) => s.command).filter(Boolean);
    const draftKey = commandSetKey(draftCmds);
    if (!draftKey) continue;

    const candidates = buckets[draftKey];
    if (!candidates || candidates.length === 0) continue;

    const draftTitle = normalizeText(draft.title);
    const draftExpected = draft.expected.map((e) => normalizeText(e.text));

    for (const cand of candidates) {
      // 1. Same negative flag
      const candNegative = cand.negative === true;
      if (draft.negative !== candNegative) continue;

      // 2. Normalised titles equal OR normalised expected texts equal
      const candTitle = normalizeText(cand.title);
      const titlesEqual = draftTitle === candTitle && draftTitle !== '';

      let expectedEqual = false;
      const candExpList = cand.expected ?? [];
      const candNormExp = candExpList.map(normalizeText);
      if (draftExpected.length > 0 && candNormExp.length > 0) {
        if (draftExpected.some((de) => candNormExp.includes(de))) {
          expectedEqual = true;
        }
      }

      if (titlesEqual || expectedEqual) {
        const doc = cand.document || '未知文档';
        const node = cand.node || '未知节点';
        const title = cand.title || '未知标题';
        outcomes.push({
          verdict: 'refute',
          code: CODES.DUPLICATE_CASE,
          statement: `起草用例“${draft.title}”与已索引用例重复：文档 ${doc} 节点 ${node}“${title}”（${cand.reference}）`,
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

  if (outcomes.length > 0) return outcomes;

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
