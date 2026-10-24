// The checks of the verification (checks.json), pure functions over the default subjects the Hub builds:
// - dispositions (item): every draft finding of the item (fields.draft_findings) gets exactly one disposition (verified,
//   refuted or partial) whose data.finding is its rec: reference; a disposition names a draft finding of this item; every
//   statement carries a location and a quotation; a new finding names its probe (data.probe, one of the seven).
// - verdict (run): the verdict (cross_item PASS, PARTIAL or FAIL, ranked with the final level) agrees with the dispositions.
//   PASS: no draft finding refuted, no new finding, the level unchanged, every draft finding of the run disposed of (also the
//   ones on skipped items), and at least one quotation of the verifier's own into the target (a quotation is checked verbatim
//   at the boundary; a location or a ground is a reference anyone can copy from the item list, and a copy of the draft's own
//   quotation is no check of the verifier's). PARTIAL: a new finding, a refuted or partly correct draft finding, or a level
//   change. FAIL: a refuted draft finding the draft itself ranked major or critical (a major factual error of the draft; the
//   rank the verifier gives its refutation does not raise a minor finding to one). A run-wide problem is reported on the
//   first handled item, so that the error table of the item requirement routes it back to the verifier.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { CheckTier } from '../../../../contracts/generated/vocabulary.ts';
import { PACK, isRecord } from './common.ts';

export const DISPOSITIONS = ['verified', 'refuted', 'partial'] as const;
export const NEW_FINDING = 'new_finding';
export const VERDICTS = ['PASS', 'PARTIAL', 'FAIL'] as const;
export const PROBES = ['literal_issue', 'coverage_gap', 'differentiation_gap', 'edge_case_gap', 'negative_gap', 'block_structure_mismatch', 'self_contradiction'] as const;
const MAJOR = new Set(['critical', 'major']);
const SLOT = 'verification';
const MAX_OUTCOMES = 200;
const TIER: CheckTier = 'blocking';

export const CODES = {
  dispositionMissing: `${PACK}.disposition_missing`,
  dispositionDuplicate: `${PACK}.disposition_duplicate`,
  findingUnknown: `${PACK}.finding_unknown`,
  locationMissing: `${PACK}.location_missing`,
  quoteMissing: `${PACK}.quote_missing`,
  probeMissing: `${PACK}.probe_missing`,
  passRefuted: `${PACK}.pass_with_refuted`,
  passNewFinding: `${PACK}.pass_with_new_finding`,
  passLevelChanged: `${PACK}.pass_level_changed`,
  passWithoutEvidence: `${PACK}.pass_without_evidence`,
  passUnverified: `${PACK}.pass_with_unverified`,
  failWithoutRefutation: `${PACK}.fail_without_major_refutation`,
  suggestionTargetMissing:PACK+'.suggestion_target_missing',
  suggestionIncomplete:PACK+'.suggestion_incomplete',
  partialWithoutChange: `${PACK}.partial_without_change`,
  verdictMissing: `${PACK}.verdict_missing`,
  levelMissing: `${PACK}.level_missing`,
} as const;

const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const dataOf = (claim: Record<string, unknown>): Record<string, unknown> => (isRecord(claim.data) ? claim.data : {});
const isDisposition = (code: unknown): boolean => (DISPOSITIONS as readonly unknown[]).includes(code);

/** The draft findings of an item, by reference, with their draft rank and quotations. */
function draftFindings(fields: unknown): Map<string, { rank: string | null; quotes: Record<string, unknown>[] }> {
  const out = new Map<string, { rank: string | null; quotes: Record<string, unknown>[] }>();
  for (const f of records(isRecord(fields) ? fields.draft_findings : undefined)) {
    if (typeof f.reference === 'string') out.set(f.reference, { rank: typeof f.rank === 'string' ? f.rank : null, quotes: records(f.quotes) });
  }
  return out;
}

export function dispositions(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const item = typeof subject.item === 'string' ? subject.item : undefined;
  const own = item !== undefined ? { item } : {};
  const slots = isRecord(subject.slots) ? subject.slots : {};
  const claims = records(slots[SLOT]);
  const draft = draftFindings(subject.fields);
  const out: CheckOutcome[] = [];
  const add = (code: string, statement: string, pointer?: string, data?: Record<string, unknown>): void => {
    if (out.length < MAX_OUTCOMES) out.push({ verdict: 'refute', code, statement, grounds: [], tier: TIER, ...own, ...(pointer !== undefined ? { pointer } : {}), ...(data !== undefined ? { data } : {}) });
  };
  const counts = new Map<string, number>();
  claims.forEach((claim, j) => {
    const pointer = `/slots/${SLOT}/${j}`;
    const finding = dataOf(claim).finding;
    if (isDisposition(claim.code)) {
      if (typeof finding !== 'string' || !draft.has(finding)) {
        add(CODES.findingUnknown, `第 ${j + 1} 条处置（${String(claim.code)}）的 data.finding 不是这个条目的初评发现；写这个条目 draft_findings 里某条发现的 reference`, pointer, { finding: typeof finding === 'string' ? finding.slice(0, 300) : null });
      } else counts.set(finding, (counts.get(finding) ?? 0) + 1);
    } else if (claim.code === NEW_FINDING) {
      if (!(PROBES as readonly unknown[]).includes(dataOf(claim).probe)) add(CODES.probeMissing, `第 ${j + 1} 条新发现没有写它属于哪类问题：data.probe 写 ${PROBES.join('、')} 之一`, pointer);
    }
    if (typeof claim.location !== 'string' || claim.location === '') add(CODES.locationMissing, `第 ${j + 1} 条陈述没有写位置：location 写它落在被复核脑图的哪个节点`, pointer);
    if (records(claim.quotes).length === 0) add(CODES.quoteMissing, `第 ${j + 1} 条陈述没有逐字引文：quotes 至少引一段原文（被复核的脑图或期望来源）`, pointer);
  });
  for (const [reference] of draft) {
    const n = counts.get(reference) ?? 0;
    if (n === 0) add(CODES.dispositionMissing, `初评发现 ${reference} 没有处置：写一条 verified、refuted 或 partial，data.finding 写这个引用`, undefined, { finding: reference });
    else if (n > 1) add(CODES.dispositionDuplicate, `初评发现 ${reference} 有 ${n} 条处置，只能有一条`, undefined, { finding: reference, count: n });
  }
  if (out.length === 0) {
    const fresh = claims.filter((c) => c.code === NEW_FINDING).length;
    const fields=isRecord(subject.fields)?subject.fields:{};
    const sourceFacts=records(fields.draft_source_facts);
    out.push({verdict:'support',statement:String(draft.size)+' 条初评发现各有一条处置，新发现 '+fresh+' 条，每条都有位置和引文',
      grounds:sourceFacts.flatMap(fact=>typeof fact.reference==='string'?[fact.reference]:[]),tier:TIER,...own,
      data:{draft:draft.size,new_findings:fresh,source_facts:sourceFacts}});

  }
  return out;
}

/** The source digest of the target: the digest every item location is rooted in. */
function targetDigest(items: readonly Record<string, unknown>[]): string | null {
  for (const it of items) {
    const m = typeof it.location === 'string' ? /^src:([0-9a-f]{64})\//.exec(it.location) : null;
    if (m !== null) return m[1];
  }
  return null;
}

/** A src: reference without the range a pinned quotation carries (`:<from>-<to>` at the end). */
const unpinned = (reference: string): string => reference.replace(/:[0-9]+-[0-9]+$/, '');
const quoteKey = (reference: string, text: string): string => JSON.stringify([unpinned(reference), text.replace(/\s+/gu, ' ').trim()]);

export function verdict(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const items = records(subject.items);
  const cross = records(subject.cross_item);
  const handled = items.filter((it) => isRecord(it.slots));
  const anchor = typeof (handled[0] ?? items[0])?.id === 'string' ? ((handled[0] ?? items[0]).id as string) : undefined;
  const own = anchor !== undefined ? { item: anchor } : {};
  const finalIndex = cross.findIndex((c) => (VERDICTS as readonly unknown[]).includes(c.code));
  if (finalIndex < 0) return [{ verdict: 'refute', code: CODES.verdictMissing, statement: '提交里没有结论：请在 cross_item 补一条 PASS、PARTIAL 或 FAIL，并写等级后重交', grounds: [], tier: TIER, ...own, pointer:'/cross_item' }];
  const final = cross[finalIndex];
  const pointer = `/cross_item/${finalIndex}`;
  const claims = handled.flatMap((it) => records((it.slots as Record<string, unknown>)[SLOT]).map((claim) => ({ claim, item: it })));
  const refuted = claims.filter(({ claim }) => claim.code === 'refuted');
  const corrected = claims.filter(({ claim }) => claim.code === 'refuted' || claim.code === 'partial');
  const fresh = claims.filter(({ claim }) => claim.code === NEW_FINDING);
  const draftLevel = (() => {
    for (const it of items) {
      const level = isRecord(it.fields) && isRecord(it.fields.draft_level) ? it.fields.draft_level : null;
      if (level !== null) return typeof level.rank === 'string' ? level.rank : null;
    }
    return null;
  })();
  const finalLevel = typeof final.rank === 'string' ? final.rank : null;
  if (!draftLevel?.trim() || !finalLevel?.trim()) return [{verdict:'refute',code:CODES.levelMissing,statement:!draftLevel?.trim()?'初评没有等级，请先补齐初评等级并重交初评，再重开复核':'复核结论没有等级，请在结论主张 rank 写最终等级后重交',grounds:[],tier:TIER,...own,pointer}];
  const levelChanged = draftLevel !== null && finalLevel !== null ? draftLevel !== finalLevel : null;
  const firstFields = isRecord(items[0]?.fields) ? (items[0].fields as Record<string, unknown>) : {};
  const case_rule = (firstFields.case_rule === 'tagged' ? 'tagged' : 'marked') as 'tagged' | 'marked';
  const marked_only = typeof firstFields.marked_only === 'number' ? firstFields.marked_only : 0;
  const ruleLine = `用例规则：${case_rule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${marked_only} 个只靠标记识别（没有标签）`;
  const data = { verdict: final.code, level: finalLevel, draft_level: draftLevel, refuted: refuted.length, corrected: corrected.length, new_findings: fresh.length, case_rule, marked_only };
  const out: CheckOutcome[] = [];
  const add = (code: string, statement: string): void => {
    out.push({ verdict: 'refute', code, statement, grounds: [], tier: TIER, ...own, pointer, data });
  };
  if (final.code === 'PASS') {
    if (refuted.length > 0) add(CODES.passRefuted, `结论 PASS，但推翻了 ${refuted.length} 条初评发现：结论应为 FAIL 或 PARTIAL`);
    if (fresh.length > 0) add(CODES.passNewFinding, `结论 PASS，但列出了 ${fresh.length} 条新发现：结论应为 PARTIAL（或 FAIL）`);
    if (levelChanged === true) add(CODES.passLevelChanged, `结论 PASS，但最终等级 ${finalLevel} 与初评等级 ${draftLevel} 不同：等级改了时结论应为 PARTIAL`);
    // Every draft finding of the run needs a disposition in a handled slot record (a skipped item disposes of none).
    const disposed = new Set(claims.flatMap(({ claim }) => (isDisposition(claim.code) && typeof dataOf(claim).finding === 'string' ? [dataOf(claim).finding as string] : [])));
    const unverified = items.flatMap((it) => [...draftFindings(it.fields).keys()].filter((reference) => !disposed.has(reference)));
    if (unverified.length > 0) add(CODES.passUnverified, `结论 PASS，但有 ${unverified.length} 条初评发现没有处置（它们所在的条目跳过了、没有提交，或者没有写处置）：PASS 之前要逐条核对每一条初评发现`);
    // A quotation of the verifier's own into the target, other than the draft's own quotations.
    const digest = targetDigest(items);
    const draftQuotes = new Set(items.flatMap((it) => [...draftFindings(it.fields).values()].flatMap((f) => f.quotes.flatMap((q) => (typeof q.reference === 'string' && typeof q.text === 'string' ? [quoteKey(q.reference, q.text)] : [])))));
    const ownQuote = claims.some(({ claim }) =>
      records(claim.quotes).some((q) => typeof q.reference === 'string' && typeof q.text === 'string' && digest !== null && q.reference.startsWith(`src:${digest}`) && !draftQuotes.has(quoteKey(q.reference, q.text))),
    );
    if (!ownQuote) {
      add(CODES.passWithoutEvidence, '结论 PASS，但复核方没有一段自己从被复核脑图里逐字引用的原文：位置和根据只是引用，照抄初评的引文也不算；PASS 至少要有一段自己核对过的被复核对象的引文');
    }
  } else if (final.code === 'FAIL') {
    const major = refuted.filter(({ claim, item }) => {
      const finding = dataOf(claim).finding;
      const rank = typeof finding === 'string' ? (draftFindings(item.fields).get(finding)?.rank ?? null) : null;
      return rank !== null && MAJOR.has(rank);
    });
    if (major.length === 0) add(CODES.failWithoutRefutation, '结论 FAIL，但没有推翻初评定为严重或主要的发现：FAIL 要有初评的重大事实错误（误判、位置错误、产品语义颠倒）；推翻的只是次要发现时结论应为 PARTIAL');
  } else if (final.code === 'PARTIAL') {
    if (fresh.length === 0 && corrected.length === 0 && levelChanged !== true) {
      add(CODES.partialWithoutChange, '结论 PARTIAL，但没有新发现，没有推翻或修正初评发现，等级也没有改：PARTIAL 要有其中之一；初评基本正确、没有补充时应为 PASS');
    }
  }
  if (out.length === 0) out.push({ verdict: 'support', statement: `结论 ${String(final.code)}（等级 ${finalLevel ?? '无'}）与处置一致\n${ruleLine}`, grounds: [], tier: TIER, ...own, pointer, data });
  return out;
}

/** A suggestion is a model judgment; its node reference and three explicit parts are checked deterministically. */
export function suggestionTargets(input:unknown):CheckOutcome[] {
  const subject=isRecord(input)&&isRecord(input.subject)?input.subject:{},items=records(subject.items);
  const anchor=items.find(item=>isRecord(item.slots)),own=typeof anchor?.id==='string'?{item:anchor.id}:{};
  const suggestions=records(subject.cross_item).flatMap((claim,index)=>claim.code==='suggestion'?[{claim,index}]:[]);
  if(suggestions.length===0)return [{verdict:'support',statement:'没有改进建议，无需补充落点',grounds:[],tier:TIER,...own}];
  if(!anchor)return [{verdict:'unknown', missing: '尚未取得本检查所需的事实：' + ('改进建议没有可挂接的已处理条目；下一步：先完成至少一个用例的复核，再重新提交建议'),reason:'missing_input',statement:'改进建议没有可挂接的已处理条目；下一步：先完成至少一个用例的复核，再重新提交建议',grounds:[],tier:TIER,data:{fix:'先把一个用例按 handled 提交复核，再重新提交建议'}}];
  const digest=targetDigest(items),out:CheckOutcome[]=[];
  for(const {claim,index} of suggestions){
    const pointer='/cross_item/'+index,grounds=Array.isArray(claim.grounds)?claim.grounds:[];
    const target=grounds.some(reference=>typeof reference==='string'&&digest!==null
      &&new RegExp('^src:'+digest+'/kityminder@1/(?:n/[^/]+|i(?:/(?:0|[1-9][0-9]*))*)(?:/@[^/]+)?(?::[0-9]+-[0-9]+)?$').test(reference));
    if(!target)out.push({verdict:'refute',code:CODES.suggestionTargetMissing,statement:'这条建议没有指向被复核脑图节点的根据；针对已有用例指向用例，补新用例指向测试子项',grounds:[],tier:TIER,...own,pointer,data:{fix:'grounds 至少给出一条指向被复核脑图的 src: 节点引用；期望来源的引用不能代替落点'}});
    const parts=typeof claim.statement==='string'?/^补：([\s\S]*?)；\s*因为：([\s\S]*?)；\s*期望：([\s\S]*)$/u.exec(claim.statement.trim()):null;
    if(parts===null||parts.slice(1).some(part=>part.trim()===''))out.push({verdict:'refute',code:CODES.suggestionIncomplete,statement:'这条建议缺少完整的三段（补：…；因为：…；期望：…）',grounds:[],tier:TIER,...own,pointer,data:{fix:'按“补：<用例>；因为：<原因>；期望：<结果>”填写三段，每段都要有内容'}});
  }
  return out.length?out:[{verdict:'support',statement:String(suggestions.length)+' 条建议都有目标脑图落点，补、因为、期望三段齐全',grounds:[],tier:TIER,...own}];
}

function totally(run: (input: unknown) => CheckOutcome[], name: string): (input: unknown) => unknown {
  return (input) => {
    try {
      return run(input);
    } catch {
      return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`检查 ${name} 内部出错（任务包的缺陷）`), reason: 'check_error', statement: `检查 ${name} 内部出错（任务包的缺陷）`, grounds: [], tier: TIER }];
    }
  };
}

export const dispositionsCheck = totally(dispositions, 'dispositions');
export const verdictCheck = totally(verdict, 'verdict');
export const suggestionTargetsCheck=totally(suggestionTargets,'suggestion_targets');

/** Without a named export: the check the subject's shape calls for. */
export default function (input: unknown): unknown {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  return Array.isArray(subject.items) ? verdictCheck(input) : dispositionsCheck(input);
}
