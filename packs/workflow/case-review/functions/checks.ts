// The pack checks of the draft (checks.json):
// - findings_sources, over the default item subject the Hub builds ({ item, label, location, fields, slots, evidence } with
//   each resolved reference and the role of its source): a finding needs a location (where in the reviewed mind map it
//   applies) and at least one verbatim quotation (grounds alone are references, not evidence the boundary checked); a
//   finding whose cited evidence all resolves into hint sources (historical test lists, A03 R[6]) has no ground for a
//   statement about the product; a command line it cites without `present` must be one the case writes (lines.ts), else it
//   is the model's statement and goes back for repair, never a fact about the case;
// - tags (tagSpelling), over the structure subjects of the run ({ subjects }, subject.ts): a category tag written unlike the
//   usual spelling of its category in the same document is an inconsistent field format, advisory, named with both spellings.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { PACK, isRecord } from './common.ts';
import { quotableLines, quotedFromCase } from './lines.ts';

export const HINT_ONLY = `${PACK}.hint_only`;
export const LOCATION_MISSING = `${PACK}.location_missing`;
export const QUOTE_MISSING = `${PACK}.quote_missing`;
export const COMMAND_NOT_IN_CASE = `${PACK}.command_not_in_case`;
export const TAG_VARIANT = `${PACK}.tag_variant`;
/** Most outcomes of one call: the slot schema caps findings per item, a run holds at most 100 items. */
const MAX_OUTCOMES = 1000;

function referencesOf(finding: Record<string, unknown>): string[] {
  const grounds = Array.isArray(finding.grounds) ? finding.grounds.filter((g): g is string => typeof g === 'string') : [];
  const quotes = Array.isArray(finding.quotes) ? finding.quotes.flatMap((q) => (isRecord(q) && typeof q.reference === 'string' ? [q.reference] : [])) : [];
  return [...new Set([...grounds, ...quotes])];
}

const quotesOf = (finding: Record<string, unknown>): unknown[] => (Array.isArray(finding.quotes) ? finding.quotes.filter((q) => isRecord(q) && typeof q.text === 'string' && q.text !== '') : []);

export function findingSources(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const item = typeof subject.item === 'string' ? subject.item : undefined;
  const own = item !== undefined ? { item } : {};
  const slots = isRecord(subject.slots) ? subject.slots : null;
  if (slots === null) return [{ verdict: 'unknown', reason: 'missing_input', statement: '这个条目没有提交槽位记录，发现的根据无从核对', grounds: [], tier: 'blocking', ...own }];
  const roles = new Map<string, unknown>();
  for (const evidence of Array.isArray(subject.evidence) ? subject.evidence : []) {
    if (isRecord(evidence) && typeof evidence.reference === 'string' && evidence.resolved === true) roles.set(evidence.reference, evidence.role);
  }
  const lines = quotableLines({ location: subject.location, fields: subject.fields }, subject.evidence);
  const findings = Array.isArray(slots.findings) ? slots.findings : [];
  const out: CheckOutcome[] = [];
  const add = (outcome: CheckOutcome): void => {
    if (out.length < MAX_OUTCOMES) out.push(outcome);
  };
  findings.forEach((finding, i) => {
    if (!isRecord(finding)) return;
    const pointer = `/slots/findings/${i}`;
    if (typeof finding.location !== 'string' || finding.location === '') {
      add({ verdict: 'refute', code: LOCATION_MISSING, statement: `第 ${i + 1} 条发现没有写位置：location 写它落在被评审脑图的哪个节点（用例、分组或文档节点的 src: 引用）`, grounds: [], tier: 'blocking', ...own, pointer });
    }
    if (quotesOf(finding).length === 0) {
      add({ verdict: 'refute', code: QUOTE_MISSING, statement: `第 ${i + 1} 条发现没有逐字引文：quotes 至少引一段原文（被评审脑图，或需求、缺陷、产品文档、手册里的原文）；grounds 只是引用，不算证据`, grounds: [], tier: 'blocking', ...own, pointer });
    }
    const cited = referencesOf(finding);
    if (cited.length > 0 && cited.every((reference) => roles.get(reference) === 'hint')) {
      add({
        verdict: 'refute',
        code: HINT_ONLY,
        statement: `第 ${i + 1} 条发现只引用了线索来源（历史测试清单、测试策略），不能作为产品行为的根据；请引用被评审的脑图或需求、缺陷、产品文档、手册、命令目录里的原文`,
        grounds: cited,
        tier: 'blocking',
        ...own,
        pointer,
      });
    }
    const commands = Array.isArray(finding.commands) ? finding.commands : [];
    commands.forEach((command, k) => {
      if (!isRecord(command) || typeof command.command !== 'string' || typeof command.present === 'boolean') return;
      if (quotedFromCase(command.command, lines)) return;
      add({
        verdict: 'refute',
        code: COMMAND_NOT_IN_CASE,
        statement: `第 ${i + 1} 条发现引用的命令行“${[...command.command].slice(0, 120).join('')}”不在这个用例的文字里：不写 present 的命令要照用例原样整条引用（只忽略空白和大小写，不删参数、不加参数）；说某个命令存在或不存在时写 present`,
        grounds: [],
        tier: 'blocking',
        ...own,
        pointer: `${pointer}/commands/${k}`,
        data: { command: [...command.command].slice(0, 300).join('') },
      });
    });
  });
  if (out.length === 0) {
    add({ verdict: 'support', statement: `${findings.length} 条发现都写了位置和逐字引文，有线索以外的根据，引用的命令行出自用例`, grounds: [], tier: 'blocking', ...own, data: { checked: findings.length } });
  }
  return out;
}

type Variant = { tag: string; usual: string; category: string };

const isVariant = (value: unknown): value is Variant => isRecord(value) && typeof value.tag === 'string' && typeof value.usual === 'string' && typeof value.category === 'string';

export function tagSpelling(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const subjects = Array.isArray(subject.subjects) ? subject.subjects : [];
  const out: CheckOutcome[] = [];
  subjects.forEach((s, i) => {
    if (!isRecord(s) || out.length >= MAX_OUTCOMES) return;
    const own = typeof s.id === 'string' && s.id !== '' ? { item: s.id } : {};
    const grounds = typeof s.location === 'string' ? [s.location] : [];
    const variants = (Array.isArray(s.tagVariants) ? s.tagVariants : []).filter(isVariant);
    if (variants.length === 0) {
      out.push({ verdict: 'support', statement: '标签的写法与本文档同一类别最常用的写法一致', grounds, tier: 'advisory', ...own });
      return;
    }
    const named = variants.slice(0, 6).map((v) => `“${v.tag}”（本文档 ${v.category} 类最常用的写法是“${v.usual}”）`);
    out.push({
      verdict: 'refute',
      code: TAG_VARIANT,
      statement: `标签写法与本文档不一致：${named.join('、')}${variants.length > 6 ? ' 等' : ''}；改成本文档的写法`,
      grounds,
      tier: 'advisory',
      ...own,
      pointer: `/subjects/${i}/tagVariants`,
      data: { variants: variants.slice(0, 20) },
    });
  });
  return out;
}

function total(run: (input: unknown) => CheckOutcome[], name: string, tier: CheckOutcome['tier']): (input: unknown) => unknown {
  return (input) => {
    try {
      return run(input);
    } catch {
      return [{ verdict: 'unknown', reason: 'check_error', statement: `检查 ${name} 内部出错（任务包的缺陷）`, grounds: [], tier }];
    }
  };
}

export const findingSourcesCheck = total(findingSources, 'findings_sources', 'blocking');
export const tagSpellingCheck = total(tagSpelling, 'tags', 'advisory');

/** Without a named export: the check the subject's shape calls for. */
export default function (input: unknown): unknown {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : null;
  return subject !== null && Array.isArray(subject.subjects) ? tagSpellingCheck(input) : findingSourcesCheck(input);
}
