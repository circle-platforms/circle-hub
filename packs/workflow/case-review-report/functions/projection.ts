// The projection of the review report (workflow@1 projection, ProjectionInput -> ProjectionOutput). Inputs:
// `verifications` (many), the rec: references of the verification runs' results (json@1: a validation result per block),
// and the required `target`, the same mind map every block reviewed (only to check the blocks sit on one source).
//
// The items are the blocks' delivered entries merged per item: an item delivered in one block and unfinished in another
// counts as delivered (that block wins); an item delivered in two blocks is a hard refusal (the run may not start).
// The run item is the overall: the worst verdict of the blocks (FAIL > PARTIAL > PASS), the worst level among tied verdicts, then the smallest record reference on a tie; a missing final names the block and the required next action. The report exposes the blocks'
// findings as a deterministic table; final prose only declares the computed verdict and level.
import type { Independence } from '../../../../contracts/generated/vocabulary.ts';
import type { ProjectedItem, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { failure, guarded, isRecord } from './common.ts';
import {reviewTables,type TableModel} from './tables.ts';
import { labelOf, isRequirementStatus, isUnsatisfiedReason, isReason, isStaticTerminal, isDynamicTerminal, type StaticTerminal, type DynamicTerminal } from './generated/vocabulary.ts';
import labels from '../tables/labels.json' with {type:'json'};

export const VERIFICATIONS_SLOT = 'verifications';
export const TARGET_SLOT = 'target';
export const VERIFY_PACK = 'case-review-verify';
export const MAX_BLOCKS = 50;
export const MAX_ITEMS = 500;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// A model review requires an established human or declared independent model family.
const ESTABLISHED = { human_non_author: true, model_family_declared: true, judge_not_author: false, not_independent: false, unknown: false } as const satisfies Record<Independence, boolean>;
function established(value: unknown): boolean {
  return typeof value === 'string' && Object.hasOwn(ESTABLISHED, value) && ESTABLISHED[value as Independence];
}

const VERDICT_ORDER:Readonly<Record<string,number>>=Object.fromEntries(labels.finalCodes.map((code,index)=>[code.code,index]));
const LEVEL_ORDER:Readonly<Record<string,number>>=Object.fromEntries(labels.finalRanks.map((rank,index)=>[rank.code,index]));
export type Verdict=string;
export type Disposition=string;

/** The validation result inside the bound rec: value and the pointer it sits at (the verify pack's own reading). */
function resultOf(model: unknown, meta: Record<string, unknown>): { result: Record<string, unknown>; base: string } | null {
  void meta;
  if (!isRecord(model)) return null;
  // The selector below starts at the bound model's root: the record wraps the result in `body`.
  if (model.kind === 'validation_result' && isRecord(model.body) && model.body.schema === 'validation@1') return { result: model.body, base: 'body' };
  if (model.schema === 'validation@1') return { result: model, base: '' };
  return null;
}

/** The final claim of one block's verification result: only the one the Hub itself supported, with its real reference. */
export function finalOf(result: Record<string, unknown>, record: string): { verdict: Verdict; level: string | null; reference: string } | null {
  const stored = Array.isArray(result.cross_item) ? result.cross_item : [];
  const cross = stored.filter(isRecord);
  // The Hub's own verdict on the block's final: the fact claims of the `final` requirement. A refuted or unknown one
  // makes the block's conclusion unknown; only the claim the Hub gave a support fact to counts, at its pointer.
  const hub = cross.filter((c) => c.requirement === 'final' && isRecord(c.statement) && typeof c.statement.verdict === 'string');
  if (hub.some((c) => (c.statement as { verdict: string }).verdict !== 'support')) return null;
  const support = hub.find((c) => (c.statement as { verdict: string }).verdict === 'support');
  const pointer = isRecord(support) && typeof support.pointer === 'string' ? support.pointer : null;
  if (pointer === null) return null;
  // The model's final claim carries the same pointer itself (the submission's cross_item index); the Hub's facts may
  // sit before it in the stored list, so match by pointer, never by position. Its code and rank sit inside `statement`.
  const claim = cross.find((c) => c.pointer === pointer && isRecord(c.statement) && typeof c.statement.code === 'string' && Object.hasOwn(VERDICT_ORDER,c.statement.code));
  if (claim === undefined || !isRecord(claim.statement)) return null;
  const statement = claim.statement as { code: Verdict; rank?: unknown };
  return {
    verdict: statement.code,
    level: typeof statement.rank === 'string' && statement.rank.trim()!=='' ? statement.rank : null,
    // pointer joins the submitted claim to its Hub fact; a rec: pointer addresses the stored result instead.
    reference: `rec:${record}#/cross_item/${stored.indexOf(claim)}`,
  };
}

export type BlockDisposition = { kind: Disposition; reference: string; itemId: string | null; text: string; rank: string | null };

const KIND_LABEL:Readonly<Record<string,string>>=Object.fromEntries(labels.dispositions.map(row=>[row.code,row.display]));

/** One short count line; individual findings are read from the deterministic table, not retranscribed as references. */
export function itemSummaryOf(dispositions:readonly BlockDisposition[]):string {
  const refuted=dispositions.filter(disposition=>KIND_LABEL[disposition.kind]==='推翻').length;
  return '复核发现 '+(dispositions.length-refuted)+' 条；推翻 '+refuted+' 条；逐条内容见评审表';
}

/** One item claim of a block: a disposition (verified/refuted/partial, data.finding names the draft finding) or a new finding. */
export function dispositionsOf(result: Record<string, unknown>, block: { record: string; base: string }): BlockDisposition[] {
  const out: BlockDisposition[] = [];
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  const prefix = block.base === '' ? '' : `${block.base}/`;
  for (const [partition, entries] of Object.entries(partitions)) {
    if (!Array.isArray(entries)) continue;
    for (let e = 0; e < entries.length; e++) {
      const entry = entries[e];
      if (!isRecord(entry) || !Array.isArray(entry.requirements)) continue;
      for (let r = 0; r < entry.requirements.length; r++) {
        const requirement = entry.requirements[r];
        if (!isRecord(requirement) || !Array.isArray(requirement.claims)) continue;
        for (let c = 0; c < requirement.claims.length; c++) {
          const claim = requirement.claims[c];
          if (!isRecord(claim) || !isRecord(claim.statement)) continue;
          const code = typeof claim.statement.code === 'string' ? claim.statement.code : null;
          if (code===null||!labels.dispositions.some(disposition=>disposition.code===code)) continue;
          out.push({
            kind: code,
            // A rec: pointer addresses the record's body (valueAt(record.body, pointer)), never the envelope.
            reference: `rec:${block.record}#/partitions/${partition}/${e}/requirements/${r}/claims/${c}`,
            itemId: typeof entry.item === 'string' ? entry.item : null,
            text: typeof claim.statement.text === 'string' ? claim.statement.text : '',
            rank: typeof claim.statement.rank === 'string' ? claim.statement.rank : null,
          });
        }
      }
    }
  }
  return out;
}

function legacySnapshot(result: Record<string, unknown>): boolean {
  const locked = isRecord(result.locks) && typeof result.locks.pack === 'string' ? result.locks.pack : '';
  const version = /^case-review-verify@(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(locked);
  return version !== null && (Number(version[1]) < 1 || Number(version[1]) === 1 && (Number(version[2]) < 1 || Number(version[2]) === 1 && Number(version[3]) === 0 && version[4] !== undefined));
}

/** Admission is decided from stored structured statuses, never from human error text. */
const STATIC_UNSETTLED = { pass:false, violation:false, judgment:false, unchecked:true, incomplete:true } satisfies Record<StaticTerminal,boolean>;
const DYNAMIC_UNSETTLED = { pass:false, fail:false, no_verdict:true, not_run:true, incomplete:true } satisfies Record<DynamicTerminal,boolean>;
function unsettled(result: Record<string, unknown>, block: number): ReturnType<typeof failure> | null {
  const independentNext = `另开会话、换不同模型家族重新复核第 ${block} 块，再用新回执开始终稿`;
  const repairNext = `修复后重交第 ${block} 块复核，核对满足后再用新回执开始终稿`;
  const errors = Array.isArray(result.errors) ? result.errors.filter(isRecord) : [];
  if (errors.length) {
    const error = errors[0];
    return failure('block_unsettled', `第 ${block} 块仍有核对错误：条目 ${String(error.item ?? '跨条目')}，码 ${String(error.code ?? '未提供')}；共 ${errors.length} 条`, `${typeof error.fix === 'string' && error.fix ? error.fix : '先按该块回执中这条错误的修正动作处理'}；${repairNext}`);
  }
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  const claims: Record<string, unknown>[] = Array.isArray(result.cross_item) ? result.cross_item.filter(isRecord).filter(claim=>claim.requirement==='final') : [];
  for (const item of Array.isArray(partitions.delivered) ? partitions.delivered.filter(isRecord) : []) {
    for (const requirement of Array.isArray(item.requirements) ? item.requirements.filter(isRecord) : []) {
      const status = isRequirementStatus(requirement.status) ? requirement.status : null;
      const who = `第 ${block} 块条目 ${String(item.item)} 的 ${String(requirement.requirement)}`;
      if (status === 'pending') {
        const layers = Array.isArray(requirement.layers) ? requirement.layers.filter(isRecord) : [];
        const layer = layers.find(v => v.layer === 'static' ? isStaticTerminal(v.terminal) && STATIC_UNSETTLED[v.terminal] : v.layer === 'dynamic' && isDynamicTerminal(v.terminal) && DYNAMIC_UNSETTLED[v.terminal]);
        const terminal = layer?.layer === 'static' && isStaticTerminal(layer.terminal) ? labelOf('layer','static')+'层 '+labelOf('static_terminal',layer.terminal) : layer?.layer === 'dynamic' && isDynamicTerminal(layer.terminal) ? labelOf('layer','dynamic')+'层 '+labelOf('dynamic_terminal',layer.terminal) : '缺少未决层终态';
        const reason = isReason(layer?.reason) ? labelOf('reason',layer.reason) : typeof layer?.reason === 'string' ? '本版词表未登记的原因 '+layer.reason : '缺少原因';
        const fact = (Array.isArray(requirement.claims) ? requirement.claims.filter(isRecord) : []).find(c => isRecord(c.qualifier) && c.qualifier.nature === 'fact' && isRecord(c.statement) && c.statement.verdict === 'unknown');
        const missing = fact && isRecord(fact.statement) && typeof fact.statement.text === 'string' ? '；缺失事实：'+fact.statement.text : '；缺失事实见该块复核回答';
        return failure('block_unsettled', `${who} ${labelOf('requirement_status',status)}；${terminal}；原因：${reason}${missing}`, `先读取第 ${block} 块复核回答中该要求项的缺失事实及下一步并执行，补齐可核验的来源和证据后重新核对或重交该块，再开始终稿`);
      }
      if (status !== 'satisfied') {
        const reason = isUnsatisfiedReason(requirement.unsatisfied_reason) ? requirement.unsatisfied_reason : null;
        const message = `${who} ${status ? labelOf('requirement_status',status) : '缺少有效状态'}：${reason ? labelOf('unsatisfied_reason',reason) : '缺少未满足原因'}`;
        const next = reason === 'independence_unknown' ? independentNext : reason === 'no_producer' ? `提交第 ${block} 块该要求项缺失的判断，受理并核对满足后再开始终稿` : reason === 'outcome_mismatch' ? `先按第 ${block} 块回执修复该要求项；${repairNext}` : `按第 ${block} 块回执补齐该要求项状态与原因并完成要求，再重新核对后开始终稿`;
        return failure('block_unsettled', message, next);
      }
      claims.push(...(Array.isArray(requirement.claims) ? requirement.claims.filter(isRecord) : []));
    }
  }
  for (const claim of claims) {
    if (!isRecord(claim.qualifier) || claim.qualifier.nature !== 'judgment' || !isRecord(claim.warrant) || claim.warrant.producer !== 'model') continue;
    if (!established(claim.warrant.independence)) return failure('block_unsettled', `第 ${block} 块条目 ${String(claim.item ?? '跨条目')} 的复核独立性未成立`, independentNext);
  }
  return null;
}

export default function project(input: unknown): unknown {
  return guarded(() => {
    const model = isRecord(input) ? input : {};
    const inputs = Array.isArray(model.inputs) ? model.inputs.filter(isRecord) : [];
    const verifications = inputs.filter((i) => i.slot === VERIFICATIONS_SLOT);
    if (verifications.length === 0) return failure('no_blocks', '没有复核结果（输入槽 verifications，每块一条 rec: 引用）', '在 inputs.verifications 里给出各块复核运行 submit_result 回执里的验证结果引用');
    if (verifications.length > MAX_BLOCKS) return failure('too_many_blocks', '分块超过 ' + String(MAX_BLOCKS) + ' 块', '先合并或分批合成终稿');

    // Read every block's validation result from its bound value: the bound `model` of a rec: input is the Hub record
    // ({ kind, schema, body }) or the validation result itself (the same reading case-review-verify does).
    const blocks: Array<{ result: Record<string, unknown>; sha256: string; base: string; record: string }> = [];
    for (let b = 0; b < verifications.length; b++) {
      const bound = verifications[b];
      const meta = isRecord(bound.meta) ? bound.meta : {};
      const record = resultOf(bound.model, meta);
      if (record === null) return failure('block_unreadable', `第 ${String(b + 1)} 块不是复核验证结果`, '每条 verifications 给 case-review-verify 运行 submit_result 回执里的 rec: 引用');
      const sha256 = typeof bound.sha256 === 'string' ? bound.sha256 : '';
      const digest = typeof meta.record === 'string' ? meta.record : '';
      if(!/^[a-f0-9]{64}$/.test(digest)||record.result.acceptance!=='accepted')return failure('block_invalid','复核结果不是已受理的原始记录','先完成复核，再用其已受理 validation_result 的 rec: 引用，不用上传的 JSON 或子指针');
      blocks.push({ result: record.result, sha256, base: record.base, record: digest });
    }

    // Every block must be a verification of the review pack over one same source: the pack its result locked and the
    // source digests its item locations point at (a result locks pack and pack_digest, not the source; the locations do).
    for (let b = 0; b < blocks.length; b++) {
      const rawLocks: unknown = blocks[b].result.locks;
      const locks: Record<string, unknown> = isRecord(rawLocks) ? rawLocks : {};
      const locked = typeof locks.pack === 'string' ? locks.pack : null;
      if (locked === null || !locked.startsWith(`${VERIFY_PACK}@`)) {
        return failure('block_invalid', `第 ${String(b + 1)} 块来自任务包 ${locked ?? '（未知）'}，不是复核任务包 ${VERIFY_PACK}`, `每条 verifications 给 ${VERIFY_PACK} 运行 submit_result 回执里的 rec: 引用`);
      }
    }
    for (const [index, block] of blocks.entries()) { const refusal = unsettled(block.result, index + 1); if (refusal) return refusal; }
    const sources=new Set(blocks.flatMap(block=>entriesOf(block.result).map(entry=>/^src:([a-f0-9]{64})\/kityminder@1\//.exec(entry.location)?.[1]??null)));
    if(sources.size!==1||sources.has(null))return failure('sources_differ','各块复核条目位置不是同一份源文件，不能合成终稿','逐个核对各块条目位置的 src: 摘要，改用同一份脑图重新复核后再开终稿');
    const source=[...sources][0]!;
    const target=inputs.find(bound=>bound.slot===TARGET_SLOT);
    const fixTarget='把 target 绑定为各块评审的同一份脑图：src:'+source;
    if(!target||target.parser!=='kityminder@1'||!isRecord(target.model)||!Array.isArray(target.model.nodes)||target.model.nodes.length===0)return failure('target_invalid','没有绑定可读的目标脑图',fixTarget);
    if(target.sha256!==source)return failure('target_mismatch','target 的字节摘要与各块条目位置的源文件不同',fixTarget);
    const params=isRecord(model.parameters)?model.parameters:{};
    const priority=params.precondition_priority===undefined?3:params.precondition_priority;
    if(priority!==null&&(!Number.isInteger(priority)||Number(priority)<1||Number(priority)>9))return failure('invalid_input','precondition_priority 应为 1 到 9 的整数或 null','改正参数后重新开始终稿运行');

    // Per-item delivery, merged over the blocks: delivered wins over anything not delivered; delivered twice is a refusal.
    const deliveredIn = new Map<string, string[]>();
    const unfinishedIds: Array<{ item: string; block: number }> = [];
    for (let b = 0; b < blocks.length; b++) {
      for (const entry of entriesOf(blocks[b].result)) {
        if (entry.partition === 'delivered') {
          const list = deliveredIn.get(entry.item) ?? [];
          list.push(String(b));
          deliveredIn.set(entry.item, list);
        } else {
          // 分区只有 delivered、rejected、quarantined、incomplete：不是 delivered 的都算没交付。
          unfinishedIds.push({ item: entry.item, block: b });
        }
      }
    }
    const overlaps = [...deliveredIn.entries()].filter(([, blocks]) => new Set(blocks).size > 1).map(([item]) => item);
    if (overlaps.length > 0) {
      return failure('overlap', `同一条目在多块里都已交付：${overlaps.slice(0, 20).join('、')}${overlaps.length > 20 ? ' 等' : ''}；重叠的块不能合成一份终稿`, '退回重叠的块重新分块（一个条目只能由一块交付），再合成终稿');
    }

    // The overall: worst verdict, worst tied level, then smallest tied record reference; unknown if a final is missing.
    const finals = blocks.map((b) => finalOf(b.result, b.record));
    let verdict: Verdict | null = null;
    let level: string | null = null;
    let reference: string | null = null;
    if (finals.every((f) => f !== null)) {
      for (const f of finals) {
        if (f === null) continue;
        if (verdict === null || VERDICT_ORDER[f.verdict] > VERDICT_ORDER[verdict] || VERDICT_ORDER[f.verdict] === VERDICT_ORDER[verdict] && ((LEVEL_ORDER[f.level ?? ''] ?? -1) > (LEVEL_ORDER[level ?? ''] ?? -1) || f.level === level && (reference === null || f.reference < reference))) {
          verdict = f.verdict;
          level = f.level;
          reference = f.reference;
        }
      }
    }

    // Items: one per delivered entry (the entry of the delivering block), each carrying that block's dispositions and
    // new findings with rec: references; plus one run item for the report.
    const items: ProjectedItem[] = [];
    for (let b = 0; b < blocks.length; b++) {
      const blockAllDispositions = dispositionsOf(blocks[b]!.result, blocks[b]!);
      for (const entry of entriesOf(blocks[b].result)) {
        if (entry.partition !== 'delivered') continue;
        const dispositions = blockAllDispositions.filter((d) => d.itemId === entry.item);
        items.push({
          id: entry.item,
          label: entry.label,
          summary: itemSummaryOf(dispositions),
          location: {
            slot: VERIFICATIONS_SLOT,
            ...(blocks[b]!.sha256 !== '' ? { source: blocks[b]!.sha256 } : {}),
            parser: 'json@1',
            // json@1 locates leaf values only: the entry's  string, not the entry object.
            // json@1 selectors walk with a leading p/ segment (p/body/partitions/…) and locate leaf values only: the
            // entry's `item` string, not the entry object.
            selector: `p/${blocks[b]!.base === '' ? '' : `${blocks[b]!.base}/`}partitions/${entry.partition}/${entry.index}/item`,
          },
          fields: {
            block: b,
          },
        });
      }
    }

    const unfinishedAnywhere = unfinishedIds.filter((u) => !deliveredIn.has(u.item));
    const missing=[...new Set(unfinishedAnywhere.map(u=>u.item))];
    // 有缺漏条目时整体记未知（覆盖不完整），列出缺漏条目，不给结论码。
    const missingBlocks=finals.flatMap((final,index)=>final===null||final.level===null?[index+1]:[]);
    const missingSourceFacts=blocks.flatMap((block,index)=>entriesOf(block.result).filter(entry=>entry.partition==='delivered').flatMap(entry=>{
      const raw=(isRecord(block.result.partitions)?block.result.partitions:{}).delivered;
      const item=Array.isArray(raw)?raw.find(value=>isRecord(value)&&value.item===entry.item):undefined;
      const kept=isRecord(item)&&Array.isArray(item.requirements)&&item.requirements.some(requirement=>isRecord(requirement)&&Array.isArray(requirement.claims)&&requirement.claims.some(claim=>
        isRecord(claim)&&isRecord(claim.qualifier)&&claim.qualifier.nature==='fact'&&isRecord(claim.warrant)&&claim.warrant.producer==='function'&&isRecord(claim.statement)&&claim.statement.verdict==='support'&&isRecord(claim.statement.data)&&Array.isArray(claim.statement.data.source_facts)));
      return kept?[]:[{block:index+1,item:entry.item,legacy:legacySnapshot(block.result)}];
    }));
    if(missingBlocks.length || missing.length) return failure('incomplete_blocks',`第 ${missingBlocks.join('、') || '已列出'} 块缺少判定或等级；未交付条目 ${missing.join('、') || '无'}`,'先完成这些块和条目的复核并重交；读取新的受理回执后再开始终稿');
    const sourceGapFix = '下一步：' + [
      missingSourceFacts.some(gap=>gap.legacy) ? '旧版块用具备初评快照的新版独立复核后重开终稿' : '',
      missingSourceFacts.some(gap=>!gap.legacy) ? '按当前块原回执补齐处置核对支持事实，修复并重交复核，再用新回执重开终稿' : '',
    ].filter(Boolean).join('；');
    const complete=missing.length===0&&missingBlocks.length===0&&missingSourceFacts.length===0&&verdict!==null;
    const reportSummary=missing.length>0
      ? '覆盖不完整：'+missing.length+' 个条目任何一块都没交付（'+missing.slice(0,10).join('、')+'）；下一步：把缺的条目重新初评、复核后，再开终稿运行'
      : missingBlocks.length>0
        ? '第 '+missingBlocks.join('、')+' 块缺少可读的结论或等级；下一步：把这些块复核完成后，再开终稿运行'
        : missingSourceFacts.length>0
          ? sourceGapFix+'；缺初评 Hub 核对快照：'+missingSourceFacts.slice(0,3).map(gap=>gap.block+' 块条目 '+gap.item.slice(0,50)).join('、')+(missingSourceFacts.length>3?' 等共 '+missingSourceFacts.length+' 项':'')
          : '整体结论码 '+verdict+'、等级 '+level+'（最差那块的，照抄）';
    const rendered=complete?reviewTables({model:target.model as unknown as TableModel,digest:source,blocks,overall:{verdict:verdict!,level},preconditionPriority:priority as number|null}):null;
    if(rendered&&'error'in rendered)return rendered;
    const full=rendered?reviewTables({model:target.model as unknown as TableModel,digest:source,blocks,overall:{verdict:verdict!,level},preconditionPriority:priority as number|null,foldEmpty:false}):null;
    if(full&&'error'in full)return full;
    const reportItem: ProjectedItem = {
      id: 'report',
      label: '评审终稿',
      summary:reportSummary+(rendered?'；评审表 '+rendered.counts.subitems.length+' 张：get_nodes 读运行记录的 #/items/0/fields/review_tables，原样贴进最终回答':''),
      location: items[0]?.location ?? { slot: VERIFICATIONS_SLOT, parser: 'json@1', selector: `p/${blocks[0]?.base ?? 'body'}/locks/pack` },
      fields: {
        blocks: blocks.length,
        overall:complete?{verdict,level,reference}:null,
        ...(rendered&&full?{review_tables:rendered.markdown,...(full.markdown===rendered.markdown?{}:{review_tables_full:full.markdown}),review_counts:rendered.counts}:{}),
        missing_items:missing,
        missing_blocks:missingBlocks,
        missing_source_facts:missingSourceFacts,
        ...(missingSourceFacts.length?{source_gap_fix:sourceGapFix}:{}),
      },
    };
    const output = { items:[reportItem,...items],warnings:[] };
    const bytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;
    if(bytes>MAX_OUTPUT_BYTES)return failure('too_large', `完整终稿投影为 ${bytes} 字节，超过 ${MAX_OUTPUT_BYTES} 字节上限`, '按更小分块分别独立复核、分别开始终稿；明确每批范围和完整记录引用，不删减发现或建议');
    return output;
  });
}

function entriesOf(result: Record<string, unknown>): Array<{ partition: string; index: number; item: string; label: string; location: string }> {
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  const out: Array<{ partition: string; index: number; item: string; label: string; location: string }> = [];
  for (const [partition, entries] of Object.entries(partitions)) {
    if (!Array.isArray(entries)) continue;
    for (const [index, entry] of entries.filter(isRecord).entries()) {
      const id = typeof entry.item === 'string' ? entry.item : null;
      if (id === null) continue;
      out.push({ partition, index, item: id, label: typeof entry.label === 'string' ? entry.label : id, location: typeof entry.location === 'string' ? entry.location : '' });
    }
  }
  return out;
}
