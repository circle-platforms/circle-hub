import {StaticTerminalSchema, type StaticTerminal, type Attribution, type CheckTier, type Verdict, type Nature, type SourceRole} from '../../../contracts/generated/vocabulary.ts';
import { PublicRefusal } from './inject.ts';
// Scores the review of a copy with injected defects against the gold written down at injection time (brief section
// 6b, review; task gold-review step 3). The Hub's own marks (a refuted fact claim of the literal and catalog
// requirements on an attributed static layer) and the model's findings (judgment claims of the findings requirement)
// are scored apart: the first must see every defect it is able to see and is compared per (case, code) with the
// independent literal answer on the untouched cases, the second is measured for recall on the injected defects and
// for noise on the untouched cases. A verify result, when given, confirms or refutes the draft's findings and adds
// its own. Only counts reach the screen; the per-node detail goes to a file.
import type { GoldEntry } from './inject.ts';
import type { LiteralAnswer } from '../gold/literal.ts';

/** The parts of a stored validation result the scorer reads (the shape `circle-hub run show --json` gives under latest.result). */
export interface ResultLike {
  partitions: Record<string, ItemLike[]>;
}
export interface ItemLike {
  item: string;
  requirements: Array<{
    requirement: string;
    layers: Array<{ terminal: StaticTerminal; code?: string; tier?: CheckTier; attribution?: Attribution }>;
    claims: Array<{ statement: { code?: string; verdict?: Verdict; data?: { probe?: string } }; qualifier?: { nature?: Nature; source_role?: SourceRole } }>;
  }>;
}

/** What one case looks like to the scorer after a review. */
export interface Seen {
  /** The item is in the delivered partition: findings count only there. */
  reviewed: boolean;
  /** Codes of the Hub's marks: refuted fact claims of literal/catalog on an attributed static layer. */
  marks: string[];
  /** Codes of the model's findings: judgment claims of the findings requirement. */
  findings: string[];
  /** Refuted fact claims that are NOT the Hub's marks (e.g. an expected refutation): shown, never counted. */
  unattributedRefutes: string[];
  /** The literal static layer of this item is neither pass nor violation (e.g. declared skipped): counted apart. */
  literalUnscored: boolean;
  /** Fact refutations judging a model statement, not the document: disclosed separately and never scored as marks. */
  modelStatementRefutes: string[];
}

export interface Detection {
  entry: GoldEntry;
  seen: Seen;
  /** The Hub's literal/catalog check saw it (mechanical entries only). */
  mechanical: boolean;
  /** The draft review found it (a judgment finding on the case). */
  draft: boolean;
  /** The verify run found it on its own (a new_finding on the case; a negative/coverage-gap probe for a deleted group). */
  verify: boolean;
  /** The verify run confirmed the draft's finding (verified or partial). */
  confirmed: boolean;
  /** Confirmed or newly found: "合起来". Without a verify result this is the draft's finding. */
  combined: boolean;
  /** entry.seen_by is judgment: found when any judgment channel saw it; mechanical entries as before. */
  detected: boolean;
}

export interface StructureCompare {
  /** Hub marked it and the independent answer has it. */
  supported: Array<{ node: string; code: string }>;
  /** Hub marked it, the independent answer does not have it. */
  falsePositives: Array<{ node: string; code: string }>;
  /** The independent answer has it, Hub did not mark it. */
  missed: Array<{ node: string; code: string }>;
}

export interface Extra {
  node: string;
  codes: string[];
  /** The baseline review of the untouched document already had a finding on this node. */
  inBaseline: boolean;
}

export interface Score {
  /** Gold entries without a kind are refused: re-inject with the current inject-defects.ts. */
  detections: Detection[];
  /** [found, total] per kind of seeing (initial review's findings for judgment). */
  recall: { mechanical: [number, number]; judgment: [number, number] };
  /** Marks of the Hub on cases no defect was injected into, split by code family. */
  structure: StructureCompare;
  /** Marks with no independent answer yet: count claims, never adjudicate them. Command paths alone do not give
   * an independent answer for catalog claims: the cited command lines and parameters need a separate tree parser. */
  otherMarks: { total: number; fresh: number; catalog: { total: number; fresh: number }; entries: Extra[] };
  /** Literal static-layer entries that are neither pass nor violation: counted apart, never scored. */
  literalUnscored: number;
  /** Cases without a unique data.id in the copy: counted apart, never scored. */
  noUniqueId: number;
  /** The original nodes excluded because data.id does not identify a case uniquely. */
  noUniqueCases: LiteralAnswer['noUniqueId'];
  /** Whether the structure comparison ran: it needs the copy's independent literal answer. When it did not, the
   * missing fact is the copy file and the next action is scoring again with it (score-injection.ts --copy); the
   * driver always passes it. */
  structureCompared: boolean;
  /** Model findings on untouched cases. */
  extras: Extra[];
  /** Verify's own new findings on untouched cases. */
  verifyExtras: string[];
}

const ScoredLiteralTerminal = StaticTerminalSchema.extract(['pass','violation']);
const nodeOf = (item: string): string => item.slice(item.lastIndexOf(':') + 1);
const isStructure = (code: string): boolean => code.startsWith('core.structure.');

const refuteCodeOf = (claim: ItemLike['requirements'][number]['claims'][number]): string | null =>
  claim.statement.verdict === 'refute' && typeof claim.statement.code === 'string' ? claim.statement.code : null;

function seenOn(result: ResultLike): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const [partition, items] of Object.entries(result.partitions)) {
    for (const item of items) {
      const marks: string[] = [];
      const unattributed: string[] = [];
      const modelStatementRefutes: string[] = [];
      let literalUnscored = false;
      for (const r of item.requirements) {
        if (r.requirement !== 'literal' && r.requirement !== 'catalog') continue;
        const staticLayer = r.layers[0];
        if (r.requirement === 'literal' && staticLayer !== undefined && !ScoredLiteralTerminal.safeParse(staticLayer.terminal).success) {
          literalUnscored = true;
        }
        // Only an attributed static layer is the Hub's own mark: an expected refutation on a negative case carries
        // no attribution (hub/runs/engine/terminals.ts) and never counts.
        const attributed = staticLayer !== undefined && staticLayer.attribution !== undefined && staticLayer.attribution !== 'unattributed';
        for (const claim of r.claims) {
          const code = refuteCodeOf(claim);
          if (code === null || claim.qualifier?.nature !== 'fact') continue;
          if (claim.qualifier.source_role === 'artifact_under_verification') {
            modelStatementRefutes.push(code);
            continue;
          }
          if (claim.qualifier.source_role !== 'subject') continue;
          if (attributed) marks.push(code);
          else unattributed.push(code);
        }
      }
      const findings = item.requirements
        .filter((r) => r.requirement === 'findings')
        .flatMap((r) => r.claims.flatMap((c) => (c.qualifier?.nature === 'judgment' && typeof c.statement.code === 'string' ? [c.statement.code] : [])));
      out.set(nodeOf(item.item), { reviewed: partition === 'delivered', marks, findings, unattributedRefutes: unattributed, modelStatementRefutes, literalUnscored });
    }
  }
  return out;
}

/** The verify reading of one case: its own new findings, and what it did with the draft's finding. */
function verifyOn(result: ResultLike): Map<string, { newFindings: string[]; confirmed: boolean; refuted: boolean }> {
  const out = new Map<string, { newFindings: string[]; confirmed: boolean; refuted: boolean }>();
  for (const items of Object.values(result.partitions)) {
    for (const item of items) {
      const codes = item.requirements
        .filter((r) => r.requirement === 'verification')
        .flatMap((r) => r.claims.flatMap((c) => (typeof c.statement.code === 'string' ? [[c.statement.code, c.statement.data?.probe ?? ''] as const] : [])));
      const record = out.get(nodeOf(item.item)) ?? { newFindings: [], confirmed: false, refuted: false };
      for (const [code, probe] of codes) {
        if (code === 'new_finding') record.newFindings.push(probe);
        if (code === 'verified' || code === 'partial') record.confirmed = true;
        if (code === 'refuted') record.refuted = true;
      }
      out.set(nodeOf(item.item), record);
    }
  }
  return out;
}

export interface ScoreOptions {
  /** The baseline review of the untouched document. */
  baseline?: ResultLike;
  /** The verify run's result, when one was made. */
  verify?: ResultLike;
  /** The independent literal answer of the copy (task step 2); structure comparison needs it. */
  literal?: LiteralAnswer;
}

export function score(gold: readonly GoldEntry[], result: ResultLike, options: ScoreOptions = {}): Score {
  for (const [index, entry] of gold.entries()) {
    if (typeof (entry as { kind?: unknown }).kind !== 'string') {
      throw new PublicRefusal('gold_kind_missing', index + 1);
    }
  }
  const seen = seenOn(result);
  const gapNodes = [...seen.entries()].filter(([,s]) => s.reviewed && s.findings.some(code => code === 'negative_gap' || code === 'coverage_gap')).map(([node])=>node);
  const documentGaps = gapNodes.flatMap(node => seen.get(node)!.findings.filter(code => code === 'negative_gap' || code === 'coverage_gap'));
  const eligible = options.literal === undefined ? undefined : new Set(options.literal.cases.map(c => c.id));
  // Hub gives missing/duplicate ids positional or suffixed identities. Only exact unique raw ids are scoreable;
  // do not guess fallback identities, which may collide with real ids in the same document.
  if (eligible !== undefined) for (const node of seen.keys()) if (!eligible.has(node)) seen.delete(node);
  const before = options.baseline === undefined ? new Map<string, Seen>() : seenOn(options.baseline);
  const verified = options.verify === undefined ? new Map<string, { newFindings: string[]; confirmed: boolean; refuted: boolean }>() : verifyOn(options.verify);
  const documentVerified = new Map(verified);
  const verifyGapProbes = [...documentVerified.values()].flatMap(v=>v.newFindings.filter(p=>p==='negative_gap' || p==='coverage_gap'));
  if (eligible !== undefined) for (const node of verified.keys()) if (!eligible.has(node)) verified.delete(node);
  const unscoreableIds = new Set(options.literal?.noUniqueId.map(c => c.id) ?? []);
  const scoreableGold = gold.filter(e => e.deletedCases !== undefined || eligible?.has(e.node) || !unscoreableIds.has(e.node));
  const touched = new Set(
    gold.flatMap((g) => [g.node, ...(g.copy === undefined ? [] : [g.copy]), ...(g.deletedCases ?? [])]),
  );

  let anyReviewed = false;
  for (const s of seen.values()) if (s.reviewed) anyReviewed = true;

  // A verify run's negative-gap or coverage-gap probe anywhere also finds a deleted negative group.

  const detections = scoreableGold.map((entry): Detection => {
    const at = (n: string): Seen | undefined => seen.get(n);
    if (entry.deletedCases !== undefined && entry.deletedCases.length > 0) {
      const nodes = [entry.node, ...entry.deletedCases];
      const here = nodes.map(at).filter((s): s is Seen => s !== undefined);
      const findings = [...new Set([...here.flatMap((s) => s.findings), ...documentGaps])];
      const groupGap = documentGaps.length > 0;
      const draft = findings.length > 0;
      const confirmNodes = [...new Set([...nodes,...gapNodes])].map((n) => documentVerified.get(n)).filter((v): v is NonNullable<typeof v> => v !== undefined);
      const vNew = confirmNodes.some((v) => v.newFindings.length > 0) || verifyGapProbes.length > 0;
      const vConfirmed = confirmNodes.some((v) => v.confirmed);
      const merged: Seen = { reviewed: anyReviewed, marks: [], findings, unattributedRefutes: [], modelStatementRefutes: [], literalUnscored: false };
      return {
        entry,
        seen: merged,
        mechanical: false,
        draft,
        verify: vNew,
        confirmed: vConfirmed,
        combined: options.verify === undefined ? draft : vConfirmed || vNew,
        detected: options.verify === undefined ? draft || groupGap : vConfirmed || vNew,
      };
    }

    const nodes = [entry.node, ...(entry.copy === undefined ? [] : [entry.copy])];
    const here = nodes.map(at).filter((s): s is Seen => s !== undefined);
    const merged: Seen = {
      reviewed: here.some((s) => s.reviewed),
      marks: here.flatMap((s) => s.marks),
      findings: here.flatMap((s) => s.findings),
      unattributedRefutes: here.flatMap((s) => s.unattributedRefutes),
      modelStatementRefutes: here.flatMap((s) => s.modelStatementRefutes),
      literalUnscored: here.some((s) => s.literalUnscored),
    };
    const mechanical = entry.seen_by === 'mechanical' && nodes.every(node => {
      const marks = at(node)?.marks ?? [];
      if (entry.kind === 'delete_expected') return marks.includes('core.structure.required_empty');
      if (entry.kind === 'duplicate') return marks.includes('core.structure.duplicate_key');
      if (entry.kind === 'replace_command_word') return marks.some(code => code.startsWith('core.catalog.'));
      const codes = options.literal?.cases.find(c => c.id === node)?.codes ?? [];
      return codes.length > 0 && codes.every(code => marks.includes(code));
    });
    const draft = merged.findings.length > 0;
    const verifyRecord = nodes.map((n) => verified.get(n)).find((v): v is NonNullable<typeof v> => v !== undefined);
    const vNew = verifyRecord?.newFindings.length !== undefined && verifyRecord.newFindings.length > 0;
    const vConfirmed = verifyRecord?.confirmed === true;
    const combined = options.verify === undefined ? draft : vConfirmed || vNew;
    return {
      entry,
      seen: merged,
      mechanical,
      draft,
      verify: vNew,
      confirmed: vConfirmed,
      combined,
      detected: entry.seen_by === 'mechanical' ? mechanical : combined,
    };
  });

  const recallOf = (kind: GoldEntry['seen_by']): [number, number] => {
    const own = detections.filter((d) => d.entry.seen_by === kind);
    return [own.filter((d) => kind === 'judgment' ? d.draft : d.mechanical).length, own.length];
  };

  // The untouched cases: the Hub's structure marks against the independent answer, everything else counted only.
  const structure: StructureCompare = { supported: [], falsePositives: [], missed: [] };
  const otherMarks: Score['otherMarks'] = { total: 0, fresh: 0, catalog: { total: 0, fresh: 0 }, entries: [] };
  let literalUnscored = 0;
  for (const [node, s] of seen) {
    if (touched.has(node)) continue;
    if (s.literalUnscored) { literalUnscored += 1; continue; }
    const structureCodes = new Set<string>();
    for (const code of s.marks) {
      if (isStructure(code)) { if (structureCodes.has(code)) continue; structureCodes.add(code); }
      if (!isStructure(code)) {
        const inBaseline = (before.get(node)?.marks ?? []).includes(code);
        otherMarks.total += 1;
        if (!inBaseline) otherMarks.fresh += 1;
        otherMarks.entries.push({ node, codes: [code], inBaseline });
        if (code.startsWith('core.catalog.')) {
          otherMarks.catalog.total += 1;
          if (!inBaseline) otherMarks.catalog.fresh += 1;
        }
        continue;
      }
      const answer = options.literal?.cases.find((c) => c.id === node)?.codes ?? [];
      const where = { node, code };
      if (answer.includes(code)) structure.supported.push(where);
      else structure.falsePositives.push(where);
    }
  }
  if (options.literal !== undefined) {
    for (const answer of options.literal.cases) {
      if (touched.has(answer.id) || seen.get(answer.id)?.literalUnscored) continue;
      for (const code of answer.codes) {
        if (!isStructure(code)) continue;
        const hub = [...seen.get(answer.id)?.marks ?? []].includes(code);
        if (!hub) structure.missed.push({ node: answer.id, code });
      }
    }
  }

  const extras = [...seen]
    .filter(([node, s]) => !touched.has(node) && s.findings.length > 0)
    .map(([node, s]): Extra => ({ node, codes: s.findings, inBaseline: (before.get(node)?.findings.length ?? 0) > 0 }));
  const verifyExtras = options.verify === undefined
    ? []
    : [...verified].filter(([node, v]) => !touched.has(node) && v.newFindings.length > 0).map(([node]) => node);
  const noUniqueId = options.literal?.noUniqueId.length ?? 0;

  return { detections, recall: { mechanical: recallOf('mechanical'), judgment: recallOf('judgment') }, structure, otherMarks, literalUnscored, noUniqueId, noUniqueCases: options.literal?.noUniqueId ?? [], extras, verifyExtras, structureCompared: options.literal !== undefined };
}

export interface AggregateRun {
  result: ResultLike;
  verify?: ResultLike;
  /** An invalid run (not accepted, wrong subject, wrong count) is counted, never scored. */
  valid: boolean;
}

export interface KindAggregate {
  kind: string;
  /** The fixed Chinese description of the kind. */
  title: string;
  injected: number;
  validRuns: number;
  /** The Hub's literal/catalog check found it (mechanical entries). */
  mechanical: number;
  draft: number;
  verify: number;
  combined: number;
}

export interface Aggregate {
  runs: { total: number; valid: number };
  kinds: KindAggregate[];
  /** Whether the core.structure.* marks on untouched cases were the same in every valid run. */
  structureStable: boolean | null;
}

export const KIND_TITLES: Readonly<Record<string, string>> = {
  delete_expected: '期望结果缺失',
  replace_expected: '期望结果换成另一段文字',
  duplicate: '同一分组里多一份相同的用例',
  move: '用例挪到别的分组',
  replace_command_word: '命令词换成目录里没有的',
  delete_negative_group: '删掉只含反向用例的分组',
  contradict_manual: '期望与手册片段矛盾',
  vague_expected: '每条期望都换成同一句含糊话',
};

/** Sums several runs by injection kind (task step 3): each kind's injections × valid runs, and how many the Hub's
 * literal check, the draft, the verify run and the two together found. */
export function aggregate(gold: readonly GoldEntry[], runs: readonly AggregateRun[], literal?: LiteralAnswer): Aggregate {
  const valid = runs.filter((r) => r.valid);
  const scores = valid.map((r) => score(gold, r.result, { verify: r.verify, literal }));
  const eligible = new Set(literal?.cases.map(c => c.id) ?? []);
  const excluded = new Set(literal?.noUniqueId.map(c => c.id) ?? []);
  const kinds: KindAggregate[] = [...new Set(gold.map((g) => g.kind))].map((kind) => {
    const entries = gold.filter((g) => g.kind === kind && (g.deletedCases !== undefined || eligible.has(g.node) || !excluded.has(g.node)));
    const count = (channel: 'mechanical' | 'draft' | 'verify' | 'combined'): number =>
      scores.reduce((sum, s) => sum + s.detections.filter((d) => d.entry.kind === kind && (channel !== 'mechanical' || d.entry.seen_by === 'mechanical') && d[channel]).length, 0);
    return {
      kind,
      title: KIND_TITLES[kind] ?? kind,
      injected: entries.length,
      validRuns: valid.length,
      mechanical: count('mechanical'),
      draft: count('draft'),
      verify: count('verify'),
      combined: count('combined'),
    };
  });
  const structureSets = scores.map((s) => new Set([...s.structure.supported, ...s.structure.falsePositives].map((m) => `${m.node}:${m.code}`)));
  const stable =
    structureSets.length <= 1
      ? null
      : structureSets.every((set) => set.size === structureSets[0]!.size && [...set].every((k) => structureSets[0]!.has(k)));
  return { runs: { total: runs.length, valid: valid.length }, kinds, structureStable: stable };
}

/** The counts for the screen: no node id, title or text appears here. */
export function render(s: Score): string[] {
  const pct = ([found, total]: [number, number]): string => (total === 0 ? '无' : `${found}/${total}`);
  const lines = [
    `Hub 自己的字面检查看得见的缺陷：查出 ${pct(s.recall.mechanical)}`,
    `只有模型判断才看得见的缺陷：初评发现 ${pct(s.recall.judgment)}，合起来 ${pct([s.detections.filter(d => d.entry.seen_by === 'judgment' && d.combined).length, s.detections.filter(d => d.entry.seen_by === 'judgment').length])}，其中被复核证实 ${s.detections.filter((d) => d.entry.seen_by === 'judgment' && d.confirmed).length}，复核另有发现 ${s.detections.filter((d) => d.entry.seen_by === 'judgment' && d.verify).length}`,
    '',
    s.structureCompared
      ? `未注入的用例上的字面标记：支持 ${s.structure.supported.length}、误报 ${s.structure.falsePositives.length}、漏标 ${s.structure.missed.length}；未独立核对 ${s.otherMarks.total}（未改动评审里没有的 ${s.otherMarks.fresh}）；目录类标记还没有独立答案 ${s.otherMarks.catalog.total} 条（未改动评审里没有的 ${s.otherMarks.catalog.fresh} 条）；不计分 ${s.literalUnscored + s.noUniqueId}（data.id 缺失或重复 ${s.noUniqueId} 个）`
      : `未注入的用例上的字面标记：没有比对（缺副本的独立答案，补法：score-injection.ts 带 --copy 重新计分）；目录类标记还没有独立答案 ${s.otherMarks.catalog.total} 条（未改动评审里没有的 ${s.otherMarks.catalog.fresh} 条）`,
    `未注入的用例上模型的发现：初评 ${s.extras.length} 个用例（未改动评审里没有的 ${s.extras.filter((e) => !e.inBaseline).length}），复核新增 ${s.verifyExtras.length} 个用例`,
  ];
  return lines;
}

/** The per-node detail that never reaches the screen (the --details file). */
export function detail(s: Score): string {
  const lines: string[] = ['逐条明细（节点编号、标签和码）：'];
  for (const d of s.detections) {
    let where: string;
    if (d.entry.copy !== undefined) where = `${d.entry.node}（副本 ${d.entry.copy}）`;
    else if (d.entry.deletedCases !== undefined && d.entry.deletedCases.length > 0) where = `分组 ${d.entry.node}，删掉用例 ${d.entry.deletedCases.join('、')}`;
    else where = d.entry.node;
    lines.push(
      `- ${d.detected ? '查出' : '漏掉'}：${d.entry.label}（${d.entry.kind}，${where}）；字面 ${d.seen.marks.join('、') || '没有'}；模型陈述的反驳 ${d.seen.modelStatementRefutes.join('、') || '没有'}；初评 ${d.seen.findings.join('、') || '没有'}${d.confirmed ? '（复核证实）' : ''}${d.verify ? '（复核发现）' : ''}${d.seen.reviewed ? '' : '；这个条目没有被评审到'}`,
    );
  }
  lines.push('', '不计分的原始用例（node_ids 检查也可能产生 required_empty 或 duplicate_key，不作为误报）：');
  for (const c of s.noUniqueCases) lines.push(`- ${c.id}：${c.reason}；不计分，请先修正原件编号后重新度量`);
  lines.push('', '未注入的用例上的字面标记：');
  for (const m of s.structure.supported) lines.push(`- 支持：${m.node} ${m.code}`);
  for (const m of s.structure.falsePositives) lines.push(`- 误报：${m.node} ${m.code}`);
  for (const m of s.structure.missed) lines.push(`- 漏标：${m.node} ${m.code}`);
  lines.push('', '还没有独立答案的标记（只计条数，不作为支持、误报或漏标）：');
  for (const m of s.otherMarks.entries) lines.push(`- ${m.node} ${m.codes.join('、')}：还没有独立答案${m.inBaseline ? '（未改动评审里也有）' : '（未改动评审里没有）'}`);
  lines.push('下一步：由集成者排期，另行解析命令树并核对被引用的命令行和参数；用例的命令路径不提供这份独立答案');
  lines.push('', '未注入的用例上模型的发现：');
  for (const e of s.extras) lines.push(`- ${e.node}：${e.codes.join('、')}${e.inBaseline ? '（未改动的评审里也有）' : ''}`);
  for (const n of s.verifyExtras) lines.push(`- 复核新增：${n}`);
  return `${lines.join('\n')}\n`;
}
