import {draftStructure,structure,expectedIdentity,STRUCTURE_RULE} from './case-identity.ts';
import { commandHeadOf } from './command-head.ts';
import { parseSrcReference, quoteIdentity } from './quote-identity.ts';
// Pack check functions for defect-to-case.
import type { CatalogEntry, CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import {
  buildCompactIndex,
  commandSetKey,
  isCompactIndex,
  normalizeCommand,
} from './compact-index.ts';
import { commandReadKeys, extractDrafts } from './subjects.ts';
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

/** Preserve every code point for verbatim comparison. */
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
      const slotPointer = `/slots/cases/${i}/data/expected/${j}/quote`;
      const at = `第 ${i + 1} 个起草用例第 ${j + 1} 个期望结果`;
      if (!exp.quote || !exp.quote.reference || !foldQuoteText(exp.quote.text)) {
        outcomes.push({ verdict: 'refute', code: CODES.QUOTE_MISSING, statement: `${at}（${slotPointer}）缺少逐字引文（quote）；修正：每个期望结果自带 {"text": "<修复说明或手册里的逐字原文>", "reference": "<引用>"}`, grounds: [], tier: 'blocking', pointer: slotPointer, ...own });
        continue;
      }
      const expected = foldQuoteText(exp.text);
      if (expected === '' || !foldQuoteText(exp.quote.text).includes(expected)) {
        outcomes.push({ verdict: 'refute', code: CODES.EXPECT_NOT_IN_QUOTE, statement: `${at}文字不是所附引文的逐字片段；修正：从这段修复说明或手册引文逐字摘取非空的期望文字，不得改写，再提交修复`, grounds: [exp.quote.reference], tier: 'blocking', pointer: `/slots/cases/${i}/data/expected/${j}/text`, ...own });
        continue;
      }
      const pointer='/cases/'+i+'/expected/'+j;
      const sources=isRecord(record.sources)?record.sources:{};
      const derived=quoteIdentity(exp.quote.reference,exp.quote.text,sources);
      const supplied=expectedIdentity(exp.identity);
      const identity='identity' in derived?derived.identity:supplied;
      if(!identity){const missing='missing' in derived?derived.missing:'缺完整期望引用身份';outcomes.push({verdict:'unknown',reason:'missing_input',missing:missing+'；下一步绑定同一原件后重核',statement:missing+'；下一步绑定同一原件后重核',grounds:[exp.quote.reference],tier:'blocking',...own,pointer});continue;}
      const parsed=parseSrcReference(exp.quote.reference);
      if(!('identity' in derived)&&(!parsed||parsed.sha256!==identity.source_sha256||parsed.parser!==identity.parser||parsed.selector!==identity.path)){outcomes.push({verdict:'refute',code:CODES.QUOTE_MISSING,statement:'quote.reference 与结构身份的原件、parser 或路径不一致',grounds:[],tier:'blocking',...own,pointer});continue;}
      const text=sources['src:'+identity.source_sha256];
      if(typeof text!=='string'){outcomes.push({verdict:'unknown',reason:'missing_input',missing:'原件 src:'+identity.source_sha256+' 的可读 UTF-8 字节；下一步绑定同一原件并补读，过大时由包作者调整有界 reads 后以新版本续做',statement:'缺完整原件字节，无法核对 byte span；下一步补读后重核',grounds:[],tier:'blocking',...own,pointer});continue;}
      const bytes=new TextEncoder().encode(text);let quote:string|null=null;try{if(identity.span.offset+identity.span.length<=bytes.byteLength)quote=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(identity.span.offset,identity.span.offset+identity.span.length));}catch{}
      if(quote!==exp.quote.text){outcomes.push({verdict:'refute',code:CODES.QUOTE_MISSING,statement:'期望引用的 byte span 与逐字原文不一致',grounds:[exp.quote.reference],tier:'blocking',...own,pointer});continue;}


    }
  }
  return outcomes.length ? outcomes : [{ verdict: 'support', statement: '所有期望结果文字均为各自引文的非空逐字片段', grounds: [], tier: 'blocking', ...own }];
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
  const field = typeof allowed.fix_field === 'string' && allowed.fix_field !== '' ? allowed.fix_field : null;
  const notes = Array.isArray(allowed.fix_notes) ? allowed.fix_notes.filter((index): index is number => Number.isInteger(index) && (index as number) >= 0) : [];
  const paths = [
    ...(field === null ? [] : [`src:${allowed.defect}/json@1/p/fields/${segment(field)}`]),
    ...notes.map((index) => `src:${allowed.defect}/json@1/p/fix_notes/${index}/comment`),
  ];
  const fix = (paths.length ? `修正：引用${paths.join('，或')}` : '修正：配置 settings.bug_fix_field 或 settings.bug_fix_actions 后重新读取缺陷') + (typeof allowed.manual === 'string' ? `，或手册 src:${allowed.manual}/<解析器>/<片段>` : '；当前未绑定手册，不允许其他来源') + '；tree:/rec: 请改引对应绑定原件的 src 片段';

  for (const [index, value] of quotes.entries()) {
    const reference = isRecord(value) && typeof value.reference === 'string' ? value.reference : '';
    let accepted = false;
    const match = /^src:([0-9a-f]{64})(?:\/([^/]+)\/(.+?)(?::[0-9]+-[0-9]+)?)?$/.exec(reference);
    if (match && match[1] === allowed.manual) accepted = true;
    if (match && match[1] === allowed.defect && match[2] === 'json@1') {
      try {
        const parts = match[3].split('/').map((part) => decodeURIComponent(part));
        const fieldPath = field !== null && parts.length === 3 && parts[0] === 'p' && parts[1] === 'fields' && parts[2] === field;
        const notePath = parts.length === 4 && parts[0] === 'p' && parts[1] === 'fix_notes' && parts[3] === 'comment' && notes.some((position) => String(position) === parts[2]);
        accepted = fieldPath || notePath;
      } catch { accepted = false; }
    }
    const position = isRecord(value) && Number.isInteger(value.case) && Number.isInteger(value.expected) ? `第 ${(value.case as number) + 1} 个起草用例第 ${(value.expected as number) + 1} 个期望结果` : `第 ${index + 1} 条引文`;
    if (!accepted) out.push({ verdict: 'refute', code: CODES.QUOTE_SOURCE_FORBIDDEN, statement: `${position}的引用 ${reference} 没有指向本条缺陷的配置修复字段或绑定的同版本线手册。${fix}`, grounds: [], tier: 'blocking', pointer: `/quotes/${index}/reference`, ...own });
  }
  return out.length ? out : [{ verdict: 'support', statement: '各引文来源均为本条缺陷的配置修复说明字段、fix_notes 中的 comment 或绑定的同版本线手册', grounds: [], tier: 'blocking', ...own }];
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
 const compact=buildCompactIndex(index);
 const coverage=(paths:string[]):string[]=>{
  const facts:string[]=[];const keys=paths.map(normalizeCommand),only=compact.only?.map(normalizeCommand);
  if(compact.invalidMetadata)facts.push('only 或 cut_keys 字段形状无效；下一步集成者修正核心元数据');
  if(Number(compact.sourceSkipped)>0)facts.push('缺少 '+compact.sourceSkipped+' 份文档；下一步作者补产新根并重绑');
  if(only&&!keys.some(key=>only.includes(key)))facts.push('索引没有收窄到草稿命令 '+keys.join('、')+'；下一步按草稿命令补读 only');
  if(compact.unplacedCommands>0)facts.push('缺 '+compact.unplacedCommands+' 个条目的 commands 字段；下一步作者补结构并重产新根');
  if(compact.unplaced>0)facts.push('存在 '+compact.unplaced+' 个未归位条目；下一步作者补完整结构声明');
  if(compact.dropped>0)facts.push('紧凑索引丢弃 '+compact.dropped+' 个条目；下一步包作者调整有界投影读取能力');
  if(compact.missingKeys?.length)facts.push('缺少请求的键 '+compact.missingKeys.join('、')+'；下一步同一根重新读取这些键');
  if(compact.cappedKeys?.length&&keys.filter(k=>!only||only.includes(k)).every(k=>compact.cappedKeys.map(normalizeCommand).includes(k)))facts.push('索引每键上限截断；下一步集成者补分页能力后同根续读');
  if(compact.sourceTruncated)facts.push('源索引截断；下一步同根补完整范围');
  if(!compact.complete&&!facts.length)facts.push('索引未声明完整范围；下一步补完整范围回执');
  return facts;
 };
 const out:CheckOutcome[]=[];
 for(const draft of drafts){const identity=draftStructure(draft as unknown as Record<string,unknown>,catalog);const paths=identity?identity.commands.map(command=>command.path):commandReadKeys(draft.steps,catalog);if(!draft.id||!catalog||paths.length===0){out.push(missing(draft,'缺草稿 id 或已解析的命令路径'));continue;}
  if(!identity){const facts=coverage(paths);const commands=new Set(Object.keys(compact.by_commands).flatMap(key=>key.split(';')));if(facts.length){out.push({...missing(draft,'草稿 '+draft.id+'（'+draft.title+'）：'+facts.join('；')),reason:'integrity_unproven'});continue;}if(unresolved>0||paths.some(path=>commands.has(normalizeCommand(path)))){out.push(missing(draft,'草稿 '+draft.id+' 的命令在索引中有同命令用例或未解析条目，缺完整结构身份，无法比较'));continue;}out.push({verdict:'support',statement:'草稿 '+draft.id+' 的命令在当前锁定索引范围内没有重复',grounds:[],tier:'advisory',...own,data:{draft_id:draft.id,requirement:'not_duplicate',rule_version:STRUCTURE_RULE,structure_key:null,scope:{build:index.build??null,only:index.only??null,entries:0}}});continue;}
  const duplicates=[...entities.values()].filter(e=>e.keys.size===1&&e.keys.has(identity.key));if(duplicates.length){for(const found of duplicates)out.push({verdict:'refute',code:CODES.DUPLICATE_CASE,statement:'按照显式结构声明，草稿 '+draft.id+' 与索引用例 '+found.document+':'+found.node+' 的规范结构身份相同',grounds:[found.reference],tier:'advisory',...own,data:{draft_id:draft.id,requirement:'not_duplicate',rule_version:DUPLICATE_CLAIM_RULE,structure_rule:STRUCTURE_RULE,structure_key:identity.key,duplicate_of:{document:found.document,node:found.node,reference:found.reference}}});continue;}
  const facts=coverage(identity.commands.map(c=>c.path));
  if(unresolved>0)facts.push('有 '+unresolved+' 个条目缺完整作者结构声明；下一步作者补 case_structure 并重产新根');
  if([...entities.values()].some(e=>e.keys.size>1))facts.push('同一索引实体存在冲突结构声明；下一步作者消解冲突后重产新根');
  if(facts.length){out.push({...missing(draft,'草稿 '+draft.id+'（'+draft.title+'）：'+facts.join('；')),reason:'integrity_unproven'});continue;}
  out.push({verdict:'support',statement:'草稿 '+draft.id+' 在当前锁定索引的已声明结构范围内未见相同结构身份',grounds:[],tier:'advisory',...own,data:{draft_id:draft.id,requirement:'not_duplicate',rule_version:STRUCTURE_RULE,structure_key:identity.key,scope:{build:index.build??null,only:index.only??null,entries:entities.size}}});
 }
 return out.length?out:[{verdict:'unknown',reason:'missing_input',missing:'本次起草用例；下一步补草稿或由运行者明确处置后续做',statement:'缺本次起草用例，下一步补草稿或明确处置',grounds:[],tier:'advisory',...own}];
}


