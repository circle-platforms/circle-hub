import {draftStructure,structure,expectedIdentity,STRUCTURE_RULE} from './case-identity.ts';
import { commandHeadOf } from './command-head.ts';
// Pack check functions for defect-to-case.
import type { CatalogEntry, CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import {
  buildCompactIndex,
  commandSetKey,
  isCompactIndex,
  normalizeCommand,
} from './compact-index.ts';
import { extractDrafts } from './subjects.ts';
import {declaredResourceTag,declareResourceTags} from './generated/vocabulary.ts';
import { CANONICAL_CATEGORIES, CODES, type CanonicalCategory, type DraftCase } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identity of a duplicate-case claim: item, requirement, code and the indexed case reference. Statement text is not part of it. */
export const DUPLICATE_CLAIM_RULE = 'defect-to-case.duplicate_claim_identity@1';

export function duplicateClaimCountKey(outcome: CheckOutcome): string | null {
  if (outcome.code !== CODES.DUPLICATE_CASE || typeof outcome.item !== 'string' || outcome.item === '') return null;
  const data = outcome.data;
  if (!isRecord(data) || data.requirement !== 'not_duplicate' || data.rule_version !== DUPLICATE_CLAIM_RULE) return null;
  const duplicate = data.duplicate_of;
  if (!isRecord(duplicate) || typeof duplicate.reference !== 'string' || duplicate.reference === '') return null;
  if(typeof data.draft_id!=='string'||typeof data.structure_key!=='string')return null;
  return JSON.stringify([outcome.item,data.draft_id,'not_duplicate',outcome.code,data.structure_key,duplicate.document,duplicate.node]);
}

/** How many duplicate-case claims share an identity. Rewording the statement does not change the count. */
export function countDuplicateClaims(outcomes: readonly CheckOutcome[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    const key = duplicateClaimCountKey(outcome);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Exact membership in the declared type field; no prefix, suffix or synonym recovery. */
export function normalizeTag(tag: string): CanonicalCategory | null {
  const declaration=declaredResourceTag(tag);
  return declaration?.test_type===true?declaration.id:null;
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

    const declaration=declareResourceTags(draft.resource);
    if(declaration.issues.length)outcomes.push({verdict:'refute',code:CODES.SHAPE_INVALID,tier:'advisory',...own,grounds:[],pointer:`/cases/${i}/resource`,statement:`${prefix}未声明的标签；允许的精确原文：${declaration.issues[0].allowed.join('、')}。作者选择闭集原文修正 resource 后重新核验`,data:{table:declaration.table,issues:declaration.issues}});
    else if(declaration.status==='undeclared')outcomes.push({verdict:'unknown',reason:'missing_input',tier:'advisory',...own,grounds:[],pointer:`/cases/${i}/resource`,missing:declaration.missing!,statement:declaration.missing!+'；下一步：'+declaration.next_action});
    if(declaration.negative!==null&&draft.negative!==declaration.negative)outcomes.push({verdict:'refute',code:CODES.SHAPE_INVALID,tier:'advisory',...own,grounds:[],pointer:`/cases/${i}/negative`,statement:`${prefix}negative 与 resource 的精确类型声明不一致；按已声明类型修正派生标记后重新核验`});

    if(!draft.id)outcomes.push({verdict:'unknown',reason:'missing_input',missing:'草稿 id；下一步客户端为每条草稿声明稳定、唯一 id 后重交',statement:'缺草稿 id，下一步补结构标识后重交',grounds:[],tier:'advisory',...own});
    const declared=draftStructure(draft as unknown as Record<string,unknown>);
    if(declared&&seenSignatures.has(declared.key))outcomes.push({verdict:'refute',code:CODES.DUPLICATE_DRAFT,statement:'同次提交存在相同完整结构身份，按草稿 id 修正重复项',grounds:[],tier:'blocking',...own,data:{draft_id:draft.id??null,structure_key:declared.key,rule_version:STRUCTURE_RULE}});
    if(declared)seenSignatures.add(declared.key);
  }

  if (outcomes.some(outcome=>outcome.tier==='blocking')) return outcomes;
  return [...outcomes,
    {
      verdict: 'support',
      statement: outcomes.length?`${drafts.length} 个起草用例的主体结构已核对；标签声明的问题另列，不表示标签通过`:`${drafts.length} 个起草用例符合团队用例结构规范`,
      grounds: [],
      tier: 'blocking',
      ...own,
    },
  ];
}

export { commandHeadOf } from './command-head.ts';

/** Declaration guard only; the registered catalog interpreter performs native signature refutation. */
export function checkCommandsRefutation(input:unknown):CheckOutcome[]{const raw=isRecord(input)?input:{},s=isRecord(raw.subject)?raw.subject:raw,own=typeof s.item==='string'?{item:s.item}:{};const out:CheckOutcome[]=[];
 for(const draft of extractDrafts(s.slots)){const declaration=declareResourceTags(draft.resource);if(!declaration.valid){out.push({verdict:'refute',code:CODES.SHAPE_INVALID,statement:'resource 不是发布闭集的精确声明，不能开启反向例外',grounds:[],tier:'advisory',...own});continue;}if(declaration.status!=='declared'){out.push({verdict:'unknown',reason:'missing_input',missing:declaration.missing!,statement:declaration.missing!+'；下一步：'+declaration.next_action,grounds:[],tier:'blocking',...own});continue;}if(draft.expects_refutation===true&&declaration.negative!==true)out.push({verdict:'refute',code:CODES.SHAPE_INVALID,statement:'expects_refutation 要求明确的反向类型声明，按 resource 闭集及预期修正',grounds:[],tier:'blocking',...own});}
 return out.length?out:[{verdict:'support',statement:'反向声明字段已核；命令签名是否反驳由冻结目录解释器另算',grounds:[],tier:'blocking',...own}];}

/** Fold whitespace as case-compile does; spelling, punctuation and case stay exact. */
function foldQuoteText(text: string): string {
  return text;
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
      const identity=expectedIdentity(exp.identity),pointer='/cases/'+i+'/expected/'+j;
      if(!identity||!Number.isSafeInteger(exp.after)||Number(exp.after)<1||Number(exp.after)>draft.steps.length){outcomes.push({verdict:'unknown',reason:'missing_input',missing:'期望引文的原件摘要、parser/路径、byte span 和 after；下一步客户端按原件补完整身份后重交',statement:'缺完整期望引用身份；下一步补原件位置与步骤绑定后重交',grounds:[],tier:'blocking',...own,pointer});continue;}
      const reference='src:'+identity.source_sha256+'/'+identity.parser+'/'+identity.path;
      if(exp.quote?.reference!==reference){outcomes.push({verdict:'refute',code:CODES.QUOTE_MISSING,statement:'quote.reference 与结构身份的原件、parser 或路径不一致',grounds:[],tier:'blocking',...own,pointer});continue;}
      const sources=isRecord(record.sources)?record.sources:{},text=sources['src:'+identity.source_sha256];
      if(typeof text!=='string'){outcomes.push({verdict:'unknown',reason:'missing_input',missing:'原件 src:'+identity.source_sha256+' 的可读 UTF-8 字节；下一步绑定同一原件并补读，过大时由包作者调整有界 reads 后以新版本续做',statement:'缺完整原件字节，无法核对 byte span；下一步补读后重核',grounds:[],tier:'blocking',...own,pointer});continue;}
      const bytes=new TextEncoder().encode(text);let quote:string|null=null;try{if(identity.span.offset+identity.span.length<=bytes.byteLength)quote=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(identity.span.offset,identity.span.offset+identity.span.length));}catch{}
      if(quote!==exp.quote.text){outcomes.push({verdict:'refute',code:CODES.QUOTE_MISSING,statement:'期望引用的 byte span 与逐字原文不一致',grounds:[reference],tier:'blocking',...own,pointer});continue;}

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
export function checkDuplicate(input:unknown):CheckOutcome[]{
 const raw=isRecord(input)?input:{},s=isRecord(raw.subject)?raw.subject:raw,own=typeof s.item==='string'?{item:s.item}:{},catalog=Array.isArray(raw.catalog)?raw.catalog as CatalogEntry[]:undefined;
 const drafts=Array.isArray(s.drafts)?s.drafts as DraftCase[]:extractDrafts(s.slots),index=isRecord(s.indexed_cases)?s.indexed_cases:null;
 const missing=(draft:DraftCase,fact:string):CheckOutcome=>({verdict:'unknown',reason:'missing_input',missing:fact+'；下一步：客户端补完整草稿身份；索引缺作者结构声明时由作者补 case_structure 后重产新根并重绑，截断时按同一根补读；非法负向命令缺合法身份时交包作者补身份合约或具名人工复核',statement:fact+'；下一步按回执补结构或范围并重开核验',grounds:[],tier:'advisory',...own,data:{draft_id:draft.id??null,requirement:'not_duplicate',rule_version:STRUCTURE_RULE,structure_key:null}});
 if(!index)return drafts.map(draft=>missing(draft,'缺冻结 indexed_cases 视图'));
 const entries=index.schema==='compact-case-index@1'&&isRecord(index.by_commands)?Object.values(index.by_commands).flatMap(v=>Array.isArray(v)?v:[]):isRecord(index.entries)?Object.values(index.entries):[];
 const entities=new Map<string,{document:string;node:string;reference:string;keys:Set<string>}>();let unresolved=0;
 for(const row of entries){if(!isRecord(row)){unresolved++;continue;}const d=isRecord(row.data)?row.data:row,identity=structure(d.case_structure,catalog);if(!identity||typeof d.document!=='string'||typeof d.node!=='string'||typeof row.reference!=='string'){unresolved++;continue;}const key=JSON.stringify([d.document,d.node]),entity=entities.get(key)??{document:d.document,node:d.node,reference:row.reference,keys:new Set<string>()};entity.keys.add(identity.key);entities.set(key,entity);}
 const incomplete=index.truncated===true||index.sourceTruncated===true||Number(index.skipped??index.sourceSkipped??0)>0||index.complete===false||Number(index.dropped??0)>0||Array.isArray(index.cut_keys)&&index.cut_keys.length>0||Array.isArray(index.cappedKeys)&&index.cappedKeys.length>0||Array.isArray(index.missingKeys)&&index.missingKeys.length>0;
 const out:CheckOutcome[]=[];
 for(const draft of drafts){const identity=draftStructure(draft as unknown as Record<string,unknown>,catalog);if(!draft.id||!identity||!catalog){out.push(missing(draft,'缺草稿 id、完整已核命令参数身份、after 或期望原件引文身份'));continue;}
  const duplicates=[...entities.values()].filter(e=>e.keys.size===1&&e.keys.has(identity.key));if(duplicates.length){for(const found of duplicates)out.push({verdict:'refute',code:CODES.DUPLICATE_CASE,statement:'按照显式结构声明，草稿 '+draft.id+' 与索引用例 '+found.document+':'+found.node+' 的规范结构身份相同',grounds:[found.reference],tier:'advisory',...own,data:{draft_id:draft.id,requirement:'not_duplicate',rule_version:DUPLICATE_CLAIM_RULE,structure_rule:STRUCTURE_RULE,structure_key:identity.key,duplicate_of:{document:found.document,node:found.node,reference:found.reference}}});continue;}
  if(incomplete||unresolved>0||[...entities.values()].some(e=>e.keys.size>1)){out.push(missing(draft,'当前索引范围不完整或有 '+unresolved+' 个条目缺完整作者结构声明'));continue;}
  out.push({verdict:'support',statement:'草稿 '+draft.id+' 在当前锁定索引的已声明结构范围内未见相同结构身份',grounds:[],tier:'advisory',...own,data:{draft_id:draft.id,requirement:'not_duplicate',rule_version:STRUCTURE_RULE,structure_key:identity.key,scope:{build:index.build??null,only:index.only??null,entries:entities.size}}});
 }
 return out.length?out:[{verdict:'unknown',reason:'missing_input',missing:'本次起草用例；下一步补草稿或由运行者明确处置后续做',statement:'缺本次起草用例，下一步补草稿或明确处置',grounds:[],tier:'advisory',...own}];
}


