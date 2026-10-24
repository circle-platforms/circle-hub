import { commandHeadOf } from './command-head.ts';
// Pack check functions for defect-to-case.
import type { CatalogEntry, CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import {
  buildCompactIndex,
  commandSetKey,
  isCompactIndex,
  normalizeCommand,
  normalizeText,
  titleKey,
} from './compact-index.ts';
import { extractDrafts } from './subjects.ts';
import { CANONICAL_CATEGORIES, CODES, type CanonicalCategory, type DraftCase } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}



/**
 * A tag carries a team-template category only when it is exactly one of the closed set's own words (the author's
 * declared closed-set field — owner's rule 10-24: a value that does not equal a declared member is a structure
 * violation, never mapped to a synonym).
 */
export function normalizeTag(tag: string): CanonicalCategory | null {
  return (CANONICAL_CATEGORIES as readonly string[]).includes(tag) ? (tag as CanonicalCategory) : null;
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

    // Duplicate check within submission: the author-declared identity compared verbatim (title text, command lines
    // as written, negative flag) — no folding, no normalization of free text (owner's rule 10-24).
    const sig = JSON.stringify([draft.title, draft.negative, draft.steps.map((s) => s.command)]);
    if (seenSignatures.has(sig)) {
      outcomes.push({
        verdict: 'refute',
        code: CODES.DUPLICATE_DRAFT,
        statement: `${prefix}“${draft.title}”在同一次提交中重复起草（标题、命令行与反向标记逐字相同）`,
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

export { commandHeadOf } from './command-head.ts';

/** Helper to match a command against catalog entries */
function matchCatalogCommand(cmdText: string, catalogEntries: CatalogEntry[]): { matched: boolean; head?: string } {
  // Word-by-word exact match against the catalog's words (no case or spacing folding — owner's rule 10-24).
  const words = cmdText.split(' ').filter((word) => word !== '');
  if (words.length === 0) return { matched: false };

  for (const entry of catalogEntries) {
    const entryWords = entry.words;
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
      const pointer = `/slots/cases/${i}/data/expected/${j}/quote`;
      const at = `第 ${i + 1} 个起草用例第 ${j + 1} 个期望结果`;
      if (!exp.quote || !exp.quote.reference || !foldQuoteText(exp.quote.text)) {
        outcomes.push({ verdict: 'refute', code: CODES.QUOTE_MISSING, statement: `${at}（${pointer}）缺少逐字引文（quote）；修正：每个期望结果自带 {"text": "<修复说明或手册里的逐字原文>", "reference": "<引用>"}`, grounds: [], tier: 'blocking', pointer, ...own });
        continue;
      }
      const expected = foldQuoteText(exp.text);
      if (expected === '' || !foldQuoteText(exp.quote.text).includes(expected)) {
        outcomes.push({ verdict: 'refute', code: CODES.EXPECT_NOT_IN_QUOTE, statement: `${at}文字不是所附引文的逐字片段（只忽略空白差异）；修正：从这段修复说明或手册引文逐字摘取非空的期望文字，不得改写，再提交修复`, grounds: [exp.quote.reference], tier: 'blocking', pointer: `/slots/cases/${i}/data/expected/${j}/text`, ...own });
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
  const segment = (field: string) => [...field].map((ch) => /[%/:\p{Cc}\p{Cf}\p{Z}]/u.test(ch) ? encodeURIComponent(ch) : ch).join('');
  const fixRef = `src:${allowed.defect}/json@1/p/fields/${segment(typeof allowed.fix_field === 'string' ? allowed.fix_field : '')}`;
  const fix = `修正：引用本条缺陷修复说明 ${fixRef}` + (typeof allowed.manual === 'string' ? `，或手册 src:${allowed.manual}/<解析器>/<片段>` : '；当前未绑定手册，不允许其他来源') + '；tree:/rec: 请改引对应绑定原件的 src 片段';

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
    const position = isRecord(value) && Number.isInteger(value.case) && Number.isInteger(value.expected) ? `第 ${(value.case as number) + 1} 个起草用例第 ${(value.expected as number) + 1} 个期望结果` : `第 ${index + 1} 条引文`;
    if (!accepted) out.push({ verdict: 'refute', code: CODES.QUOTE_SOURCE_FORBIDDEN, statement: `${position}的引用 ${reference} 没有指向本条缺陷的配置修复字段或绑定的同版本线手册。${fix}`, grounds: [], tier: 'blocking', pointer: `/quotes/${index}/reference`, ...own });
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
        verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('没有绑定用例索引（indexed_cases），无法核对重复用例'),
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
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`起草用例“${title}”的命令行“${line}”在锁定构建的命令目录里解析不出命令头，无法核对重复（命令检查已另行驳回它）`),
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

  const duplicated = new Set<unknown>();
  for (const draft of headSets.keys()) {
    const heads = headSets.get(draft) ?? [];
    const draftKey = commandSetKey(heads);
    if (!draftKey) continue;

    const candidates = buckets[draftKey];
    if (!candidates || candidates.length === 0) continue;


    for (const cand of candidates) {
      // 1. Same negative flag
      const candNegative = cand.negative === true;
      if ((draft as { negative?: boolean }).negative === true !== candNegative) continue;

      // Case entries carry no expected-text field (the index fields are commands,document,node,title,negative): the
      // comparison is the title compared verbatim (plus the negative flag above and the command-set key that picked
      // the bucket); a title that differs by case or spacing is only a same-titled case, not a duplicate.
      const candTitle = cand.title;
      const titlesEqual = (draft as { title?: string }).title === candTitle;

      if (titlesEqual) {
        duplicated.add(draft);
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

  // Refutations depend only on visible bytes; absence claims require complete coverage for each draft.
  for (const draft of headSets.keys()) {
    if (duplicated.has(draft)) continue;
    const title = (draft as { title?: string }).title ?? '（无标题）';
    const heads = headSets.get(draft) ?? [];
    const missing = missingKeys.filter(k => heads.some(h => normalizeCommand(h) === normalizeCommand(k)));
    const gaps: string[] = [];
    if ((compactIndex.sourceSkipped ?? 0) > 0) gaps.push('锁定根缺少 ' + compactIndex.sourceSkipped + ' 份文档，请修复或确认接纳被跳过的来源，重新同步生成新根并重跑；重读旧根不能补齐');
    if (undecidable.has(draft)) gaps.push('索引没有收窄到草稿命令（' + heads.join('、') + '），请按本草稿命令收窄 only 和查重所需 fields 后补读一次；仍不全则向集成者报告能力缺口');
    if (missing.length > 0) gaps.push('源视图缺少请求的键：' + missing.join('、') + '，请按草稿命令收窄 only 和查重所需 fields 后补读一次；仍缺失则向集成者报告截断或凭据排除能力缺口');
    if (cappedOnly.has(draft)) gaps.push('命令所在键受每键上限影响，任何重读都不能提高此上限；请向集成者报告分键补读能力缺口，补齐后重跑');
    if (compactIndex.sourceTruncated) gaps.push('源视图已截断，请按草稿命令收窄 only 和查重所需 fields 后补读一次；仍截断则向集成者报告预算或凭据排除能力缺口，补齐后重跑');
    if ((compactIndex.unplacedCommands ?? 0) > 0) gaps.push('索引有条目没有带 commands 字段，请重新生产带 commands 的索引');
    if (compactIndex.dropped > 0) gaps.push('紧凑索引超出大小上限丢弃了 ' + compactIndex.dropped + ' 个用例，请按草稿命令收窄 only 和查重所需 fields 后补读一次；仍丢弃则向集成者报告紧凑索引容量缺口，补齐后重跑');
    if (compactIndex.invalidMetadata) gaps.push('源视图的 only 或 cut_keys 字段形状无效，请向集成者报告核心索引视图元数据缺陷；修复并导出合法字段后重跑');
    if (!compactIndex.complete && !gaps.length) gaps.push('源视图的 only、cut_keys 或紧凑索引完整性声明无效，请向集成者提供该视图和生产记录，核对元数据并修复后重跑');
    const gap = gaps.join('；');
    const narrowingOnly = undecidable.has(draft) && gaps.length === 1;
    outcomes.push(gap ? {
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('起草用例“' + title + '”未能证明没有重复：' + gap), reason: narrowingOnly ? 'missing_input' : 'integrity_unproven',
      statement: '起草用例“' + title + '”未能证明没有重复：' + gap, grounds: [], tier: 'advisory', ...own,
      data: { missing_keys: missing },
    } : { verdict: 'support', statement: '起草用例“' + title + '”未发现与已索引用例重复', grounds: [], tier: 'advisory', ...own });
  }
  return outcomes;
}
