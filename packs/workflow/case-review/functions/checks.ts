// The pack checks of the draft (checks.json):
// - findings_sources, over the default item subject the Hub builds ({ item, label, location, fields, slots, evidence } with
//   each resolved reference and the role of its source): a finding needs a location (where in the reviewed mind map it
//   applies) and at least one verbatim quotation (grounds alone are references, not evidence the boundary checked); a
//   finding whose cited evidence all resolves into hint sources (historical test lists, A03 R[6]) has no ground for a
//   statement about the product; a command line it cites without `present` must be one the case writes (lines.ts), else it
//   is the model's statement and goes back for repair, never a fact about the case;
// - tags (tagSpelling): exact author resource declarations against the published closed set, advisory.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { PACK, isRecord } from './common.ts';
import {declareResourceTags} from './generated/vocabulary.ts';
import { quotableLines, quotedFromCase } from './lines.ts';

export const HINT_ONLY = `${PACK}.hint_only`;
export const LOCATION_MISSING = `${PACK}.location_missing`;
export const QUOTE_MISSING = `${PACK}.quote_missing`;
export const COMMAND_NOT_IN_CASE = `${PACK}.command_not_in_case`;
export const NEGATIVE_COMMAND_MISSING = `${PACK}.negative_command_missing`;
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
  const slots = isRecord(subject.slots) ? subject.slots : {};
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

/** A negative case must contain a line whose head belongs to the locked catalog. */
export function negativeCommands(input:unknown):CheckOutcome[] {
  const raw=isRecord(input)?input:{},subject=isRecord(raw.subject)?raw.subject:{};
  const own=typeof subject.item==='string'?{item:subject.item}:{};
  const phrases=Array.isArray(subject.phrases)?subject.phrases.filter((p):p is string=>typeof p==='string'):[];
  if(subject.negative!==true)return [{verdict:'support',statement:'未声明反向标记，此项不要求非法命令行',grounds:[],tier:'advisory',...own}];
  const catalog=isRecord(raw.catalog)?raw.catalog:{};
  if(!Array.isArray(raw.catalog)&&!Array.isArray(catalog.entries))return [{verdict:'unknown',reason:'missing_input',missing:'冻结命令目录；下一步：请集成者选择有命令目录的构建或恢复目录绑定后重开评审',statement:'缺少冻结命令目录；请集成者选择有命令目录的构建或恢复目录绑定后重开评审，不能据此断言用例没有命令',grounds:[],tier:'advisory',...own}];
  const entries=Array.isArray(raw.catalog)?raw.catalog.filter(isRecord):Array.isArray(catalog.entries)?catalog.entries.filter(isRecord):[];
  // The owner's rule (10-24): no folding, no prefix heuristics on free text. A line carries a catalog command only
  // when its leading words equal a locked catalog head word by word (exact match); the longest such head counts.
  const wordLists=entries.map(entry=>Array.isArray(entry.words)?entry.words.filter((w):w is string=>typeof w==='string'&&w!==''):typeof entry.head==='string'&&entry.head!==''?entry.head.split(' '):[]);
  const matchesHead=(phrase:string):boolean=>{
    const words=phrase.split(' ').filter(w=>w!=='');
    return wordLists.some(head=>head.length>0&&head.length<=words.length&&head.every((word,i)=>words[i]===word));
  };
  const found=phrases.filter(matchesHead);
  return found.length ? [{verdict:'support',statement:'反向用例有目录命令行，参数反驳由目录检查核验',grounds:[],tier:'advisory',...own}]
    : [{verdict:'refute',code:NEGATIVE_COMMAND_MISSING,statement:'按当前目录的行首解析，反向用例没有可核验命令行；请核对目录范围，将完整非法命令单独成行并写期望反驳后重开评审',grounds:[],tier:'advisory',...own,pointer:'/phrases',data:{path:'/phrases',matched_commands:0,catalog_entries:entries.length,provided_lines:phrases.length}}];
}

/** Literal author-field validation; neither document frequency nor spelling resemblance supplies a declaration. */
export function tagSpelling(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const subjects = Array.isArray(subject.subjects) ? subject.subjects : [];
  return subjects.filter(isRecord).slice(0,MAX_OUTCOMES).map((s,i):CheckOutcome=>{
    const own=typeof s.id==='string'?{item:s.id}:{};
    const grounds=typeof s.location==='string'?[s.location]:[];
    const declaration=declareResourceTags(s.resourcePresent===false?undefined:Object.hasOwn(s,'resource')?s.resource:s.tags);
    if(declaration.issues.length){
      return {verdict:'refute',code:TAG_VARIANT,tier:'advisory',...own,grounds,pointer:`/subjects/${i}/resource`,
        statement:`未声明的标签：${declaration.issues.map(issue=>JSON.stringify(issue.raw)).join('、')}；允许的精确原文：${declaration.issues[0].allowed.join('、')}。作者从闭集选择原文修正 resource 后重新核验，不推测应选哪项`,
        data:{table:declaration.table,issues:declaration.issues}};
    }
    if(declaration.status==='undeclared')return {verdict:'unknown',reason:'missing_input',tier:'advisory',...own,grounds,pointer:`/subjects/${i}/resource`,missing:declaration.missing!,statement:declaration.missing!+'；下一步：'+declaration.next_action,data:{table:declaration.table,status:declaration.status}};
    return {verdict:'support',tier:'advisory',...own,grounds,pointer:`/subjects/${i}/resource`,statement:'resource 的标签逐项等于发布闭集声明的原文，测试类型已声明',data:{table:declaration.table,types:declaration.types}};
  });
}

function total(run: (input: unknown) => CheckOutcome[], name: string, tier: CheckOutcome['tier']): (input: unknown) => unknown {
  return (input) => {
    try {
      return run(input);
    } catch {
      return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`检查 ${name} 内部出错（任务包的缺陷）`), reason: 'check_error', statement: `检查 ${name} 内部出错（任务包的缺陷）`, grounds: [], tier }];
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
