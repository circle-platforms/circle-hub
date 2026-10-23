// The projection of the review report (workflow@1 projection, ProjectionInput -> ProjectionOutput). Inputs:
// `verifications` (many), the rec: references of the verification runs' results (json@1: a validation result per block),
// and the optional `target`, the same mind map every block reviewed (only to check the blocks sit on one source).
//
// The items are the blocks' delivered entries merged per item: an item delivered in one block and unfinished in another
// counts as delivered (that block wins); an item delivered in two blocks is a hard refusal (the run may not start).
// The run item is the overall: the worst verdict of the blocks (FAIL > PARTIAL > PASS), the level of the block that gave
// the worst verdict, unknown when any block's final is missing or unreadable. The report writer cites the blocks'
// verified, partial and new findings by their rec: references; the checks make sure none is missing and none refuted.
import type { ProjectedItem, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { failure, guarded, isRecord } from './common.ts';

export const VERIFICATIONS_SLOT = 'verifications';
export const TARGET_SLOT = 'target';
export const VERIFY_PACK = 'case-review-verify';
export const MAX_BLOCKS = 50;
export const MAX_ITEMS = 500;

const VERDICT_ORDER = { PASS: 0, PARTIAL: 1, FAIL: 2 } as const;
export type Verdict = keyof typeof VERDICT_ORDER;
export type Disposition = 'verified' | 'refuted' | 'partial' | 'new_finding';

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
  const claim = cross.find((c) => c.pointer === pointer && isRecord(c.statement) && typeof c.statement.code === 'string' && c.statement.code in VERDICT_ORDER);
  if (claim === undefined || !isRecord(claim.statement)) return null;
  const statement = claim.statement as { code: Verdict; rank?: unknown };
  return {
    verdict: statement.code,
    level: typeof statement.rank === 'string' ? statement.rank : null,
    // pointer joins the submitted claim to its Hub fact; a rec: pointer addresses the stored result instead.
    reference: `rec:${record}#/cross_item/${stored.indexOf(claim)}`,
  };
}

export type BlockDisposition = { kind: Disposition; reference: string; itemId: string | null; text: string; rank: string | null };

const KIND_LABEL: Record<Disposition, string> = {
  verified: '证实',
  partial: '部分正确',
  new_finding: '新增',
  refuted: '推翻',
};

/** One short line the model reads about the item: finding references to cite, and how many were refuted. */
export function itemSummaryOf(dispositions: readonly BlockDisposition[]): string {
  const citable = dispositions.filter((d) => d.kind === 'verified' || d.kind === 'partial' || d.kind === 'new_finding');
  const refuted = dispositions.filter((d) => d.kind === 'refuted');
  const citedText = citable.length > 0
    ? citable.map((d) => `${KIND_LABEL[d.kind]} ${d.reference}`).join('、')
    : '没有要引用的发现';
  return `${citedText}；推翻 ${refuted.length} 条`;
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
          if (code !== 'verified' && code !== 'refuted' && code !== 'partial' && code !== 'new_finding') continue;
          out.push({
            kind: code,
            // A rec: pointer addresses the record's body (valueAt(record.body, pointer)), never the envelope.
            reference: `rec:${block.record}#/partitions/${partition}/${e}/requirements/${r}/claims/${c}`,
            itemId: typeof entry.item === 'string' ? entry.item : null,
            text: typeof claim.statement.text === 'string' ? claim.statement.text.slice(0, 400) : '',
            rank: typeof claim.statement.rank === 'string' ? claim.statement.rank : null,
          });
        }
      }
    }
  }
  return out;
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
    const sourceOf = (result: Record<string, unknown>): string | null => {
      for (const entry of entriesOf(result)) {
        const found = /src:([0-9a-f]{64})\//.exec(String(entry.location));
        if (found !== null) return found[1]!;
      }
      return null;
    };
    const sources = new Set(blocks.map((b) => sourceOf(b.result)));
    if (sources.has(null) || sources.size > 1) {
      return failure('sources_differ', '各块复核不是同一份源文件（条目位置指向不同构建），不能合成一份终稿', '各块用同一份被评审脑图重新复核，或分别出终稿');
    }

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

    // The overall: the worst verdict; the level of the block that gave it; unknown when any final is missing.
    const finals = blocks.map((b) => finalOf(b.result, b.record));
    let verdict: Verdict | null = null;
    let level: string | null = null;
    let reference: string | null = null;
    if (finals.every((f) => f !== null)) {
      for (const f of finals) {
        if (f === null) continue;
        if (verdict === null || VERDICT_ORDER[f.verdict] > VERDICT_ORDER[verdict]) {
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
            dispositions: dispositions.map((d) => ({ kind: d.kind, reference: d.reference, text: d.text, rank: d.rank, block: b })),
          },
        });
      }
    }

    const unfinishedAnywhere = unfinishedIds.filter((u) => !deliveredIn.has(u.item));
    const missing = unfinishedAnywhere.map((u) => u.item);
    // 有缺漏条目时整体记未知（覆盖不完整），列出缺漏条目，不给结论码。
    const reportSummary = missing.length > 0
      ? `覆盖不完整：${missing.length} 个条目任何一块都没交付（${missing.slice(0, 10).join('、')}），整体结论未知`
      : verdict === null
        ? '整体结论未知（各块没有可读结论）'
        : `整体结论码 ${verdict}、等级 ${level ?? '未给'}（最差那块的，照抄）`;
    const reportItem: ProjectedItem = {
      id: 'report',
      label: '评审终稿',
      summary: reportSummary,
      location: items[0]?.location ?? { slot: VERIFICATIONS_SLOT, parser: 'json@1', selector: `p/${blocks[0]?.base ?? 'body'}/locks/pack` },
      fields: {
        blocks: blocks.length,
        overall: missing.length > 0 || verdict === null ? null : { verdict, level, reference },
        findings: collectFindings(blocks),
        missing_items: missing,
      },
    };
    return { items: [...items, reportItem], warnings: [] };
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

function collectFindings(blocks: Array<{ result: Record<string, unknown>; record: string; base: string }>): Array<{ kind: Disposition; reference: string; block: number; text: string; rank: string | null }> {
  const out: Array<{ kind: Disposition; reference: string; block: number; text: string; rank: string | null }> = [];
  for (let b = 0; b < blocks.length; b++) {
    // Every disposition, the refuted ones too: the report check must see them to refuse a report that cites one.
    for (const d of dispositionsOf(blocks[b]!.result, blocks[b]!)) {
      out.push({ kind: d.kind, reference: d.reference, block: b, text: d.text, rank: d.rank });
    }
  }
  return out;
}
