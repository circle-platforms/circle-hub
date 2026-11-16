// The written result of a replay: summary.json (counts, reasons, normalizations, pack proofs, one line per validation) and
// details.md (in Chinese: what was replayed, what is not replayable and why, every difference field by field). Several parts
// (one per release tree of a faithful replay) merge into one report. Pure functions of the parts.
import { describeDiff, groupDiffs, type AppliedNormalization, type FieldDiff } from './submissions-compare.ts';
import type { RunReport, ValidationOutcome } from './submissions-run.ts';

export const SUMMARY_SCHEMA = 'replay-summary@1';

export interface ReportMeta {
  mode: 'faithful' | 'candidate';
  created_at: string;
  /** The export folder, the bundle folder and the commits, as the caller names them (no secrets in any of them). */
  export_dir: string;
  bundle_dir: string | null;
  note?: string;
}

export interface SummaryLine {
  seq: number;
  run: string;
  pack: string;
  at: string;
  ordinal: number;
  release: string | null;
  commit: string;
  status: ValidationOutcome['status'];
  reason?: { code: string; message: string };
  rebound?: { from: string; to: string };
  fields: string[];
  diffs: number;
}

export interface Summary {
  schema: typeof SUMMARY_SCHEMA;
  meta: ReportMeta;
  commits: string[];
  totals: { validations: number; same: number; changed: number; not_replayable: number; skipped: number };
  not_replayable_by_reason: Record<string, number>;
  /** Candidate: the validations whose run kept its pack (the commit's pack is the recorded one) and those that were bound to another version. */
  by_binding: { same_pack: Record<string, number>; rebound: Record<string, number> };
  normalizations: AppliedNormalization[];
  packs: Array<{ commit: string; pack: string; digest: string; status: string; found?: string | null }>;
  lines: SummaryLine[];
  notes: string[];
}

const CLIP = 600;
const clip = (text: string): string => (text.length <= CLIP ? text : `${text.slice(0, CLIP - 1)}…`);

/** Merges the parts of a replay. The normalizations of the parts are added up by rule. */
export function summarize(parts: readonly RunReport[], meta: ReportMeta): Summary {
  const lines: SummaryLine[] = [];
  const reasons: Record<string, number> = {};
  const totals = { validations: 0, same: 0, changed: 0, not_replayable: 0, skipped: 0 };
  const binding = { same_pack: {} as Record<string, number>, rebound: {} as Record<string, number> };
  const normalizations = new Map<string, AppliedNormalization>();
  const packs: Summary['packs'] = [];
  const notes: string[] = [];
  for (const part of parts) {
    totals.skipped += part.skipped;
    notes.push(...part.notes.map((n) => `${part.commit.slice(0, 10)}：${n}`));
    for (const pack of part.packs) packs.push({ commit: part.commit, pack: pack.pack, digest: pack.digest, status: pack.status, ...(pack.found === undefined ? {} : { found: pack.found }) });
    for (const outcome of part.outcomes) {
      totals.validations += 1;
      totals[outcome.status] += 1;
      const group = outcome.rebound === undefined ? binding.same_pack : binding.rebound;
      group[outcome.status] = (group[outcome.status] ?? 0) + 1;
      if (outcome.status === 'not_replayable') reasons[outcome.reason?.code ?? 'unknown'] = (reasons[outcome.reason?.code ?? 'unknown'] ?? 0) + 1;
      for (const applied of outcome.comparison?.normalizations ?? []) {
        const known = normalizations.get(applied.id);
        if (known === undefined) normalizations.set(applied.id, { ...applied });
        else {
          known.recorded += applied.recorded;
          known.replayed += applied.replayed;
        }
      }
      const diffs = outcome.comparison?.diffs ?? [];
      lines.push({
        seq: outcome.seq, run: outcome.run, pack: outcome.pack, at: outcome.at, ordinal: outcome.ordinal, release: outcome.release, commit: part.commit, status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.rebound === undefined ? {} : { rebound: outcome.rebound }),
        fields: [...new Set(diffs.map((d) => d.field))], diffs: diffs.length,
      });
    }
  }
  lines.sort((a, b) => a.seq - b.seq);
  return { schema: SUMMARY_SCHEMA, meta, commits: [...new Set(parts.map((p) => p.commit))], totals, not_replayable_by_reason: reasons, by_binding: binding, normalizations: [...normalizations.values()], packs, lines, notes };
}

const REASON_TEXT: Record<string, string> = {
  no_bundle: '没有 Hub 数据包（验证读的知识树、来源原件、记录和任务包都在 Hub 的数据库里）',
  no_submission: '不是对某次提交的核对（运行自己产生的结果，不经 submit_result）',
  not_in_bundle: '数据包里没有这条记录',
  no_call_facts: '数据包里没有存下这条结果的 validate 动作（不知道当时调用的会话和模型）',
  bundle_damaged: '数据包的记录摘要与内容对不上',
  no_principal: '运行的运行者账户不在数据包里',
  replay_error: '回放时出错',
  served_from_record: '回放时 Hub 答的是已存的结果，没有重新核对',
  pack_not_in_commit: '这棵代码树里没有这个任务包',
  pack_refused: '候选的任务包打不成发布目录',
  candidate_pack_refused: '候选的任务包发布被拒',
};

/** The Chinese report. */
export function renderDetails(summary: Summary, parts: readonly RunReport[]): string {
  const out: string[] = [];
  const t = summary.totals;
  out.push(`# 提交回放（${summary.meta.mode === 'faithful' ? '忠实模式' : '候选模式'}）`, '');
  out.push(`- 生成时间：${summary.meta.created_at}`);
  out.push(`- 记录导出：${summary.meta.export_dir}`);
  out.push(`- Hub 数据包：${summary.meta.bundle_dir ?? '（没有）'}`);
  out.push(`- 代码树的提交：${summary.commits.map((c) => c.slice(0, 12)).join('、')}`);
  if (summary.meta.note !== undefined) out.push(`- 说明：${summary.meta.note}`);
  out.push('', '## 结果', '');
  out.push(`共 ${t.validations} 条核对结果参与回放：相同 ${t.same}，不同 ${t.changed}，不能回放 ${t.not_replayable}；另有 ${t.skipped} 条不属于这棵树（别的发布版本的树负责）或未选中。`);
  if (t.validations > 0 && t.not_replayable === t.validations) out.push('', '**没有一条被真正回放**：缺少 Hub 数据，见下面「不能回放」。这不是通过，也不是失败。');
  else if (t.changed === 0 && t.same > 0) out.push('', `可回放的 ${t.same} 条全部相同。`);
  if (summary.meta.mode === 'candidate') {
    const row = (name: string, group: Record<string, number>): string => `- ${name}：相同 ${group.same ?? 0}，不同 ${group.changed ?? 0}，不能回放 ${group.not_replayable ?? 0}`;
    out.push('', '候选模式按运行有没有改绑任务包分开看：', row('任务包没变（候选里的包摘要和运行启动时一样，只有 Hub 代码是候选的，要全部相同）', summary.by_binding.same_pack), row('改绑到候选的同名任务包（包变了，不同是预期要逐条看的）', summary.by_binding.rebound));
  }
  if (summary.packs.length > 0) {
    out.push('', '## 任务包摘要：这棵树能否重算出运行启动时的包', '', '| 提交 | 任务包 | 记录的摘要 | 结果 |', '|---|---|---|---|');
    for (const pack of summary.packs) out.push(`| ${pack.commit.slice(0, 10)} | ${pack.pack} | ${pack.digest.slice(0, 16)}… | ${pack.status === 'same' ? '重算相同' : pack.status === 'absent' ? '树里没有这个版本' : `不同（树里是 ${String(pack.found).slice(0, 16)}…）`} |`);
  }
  if (summary.normalizations.length > 0) {
    out.push('', '## 做了哪些归一（只有这些；其余字段逐字比较）', '', '| 规则 | 理由 | 记录里替换的个数 | 回放里替换的个数 |', '|---|---|---|---|');
    for (const n of summary.normalizations) out.push(`| ${n.id} | ${n.description} | ${n.recorded} | ${n.replayed} |`);
  }
  const unreplayable = Object.entries(summary.not_replayable_by_reason);
  if (unreplayable.length > 0) {
    out.push('', '## 不能回放', '');
    for (const [code, count] of unreplayable) out.push(`- ${code}（${count} 条）：${REASON_TEXT[code] ?? ''}`);
    out.push('', '| 位置 | 运行 | 任务包 | 第几次核对 | 原因 | 说明 |', '|---|---|---|---|---|---|');
    const said = new Set<string>();
    for (const line of summary.lines.filter((l) => l.status === 'not_replayable')) {
      const message = clip(line.reason?.message ?? '').replaceAll('|', '／').replaceAll('\n', ' ');
      const key = `${line.reason?.code}\0${message}`;
      out.push(`| ${line.seq} | ${line.run} | ${line.pack} | ${line.ordinal || '—'} | ${line.reason?.code ?? ''} | ${said.has(key) ? '（同上）' : message} |`);
      said.add(key);
    }
  }
  const changed = parts.flatMap((p) => p.outcomes.filter((o) => o.status === 'changed'));
  if (changed.length > 0) {
    out.push('', '## 不同', '');
    for (const outcome of changed.sort((a, b) => a.seq - b.seq)) {
      out.push(`### 位置 ${outcome.seq}：${outcome.run}（${outcome.pack}${outcome.rebound === undefined ? '' : ` → ${outcome.rebound.to}`}，第 ${outcome.ordinal} 次核对，${outcome.at}）`, '');
      for (const group of groupDiffs(outcome.comparison?.diffs ?? [])) {
        out.push(`- ${group.field}（${group.diffs.length} 处）`);
        for (const diff of group.diffs.slice(0, 40)) out.push(`  - ${describeDiff(diff as FieldDiff)}`);
        if (group.diffs.length > 40) out.push(`  - …另有 ${group.diffs.length - 40} 处`);
      }
      out.push('');
    }
  }
  if (summary.notes.length > 0) out.push('', '## 备注', '', ...summary.notes.map((n) => `- ${n}`));
  out.push('', '## 逐条', '', '| 位置 | 运行 | 任务包 | 第几次 | 发布版本 | 结果 |', '|---|---|---|---|---|---|');
  for (const line of summary.lines) out.push(`| ${line.seq} | ${line.run} | ${line.pack}${line.rebound === undefined ? '' : ` → ${line.rebound.to}`} | ${line.ordinal || '—'} | ${line.release?.slice(0, 10) ?? '—'} | ${line.status === 'same' ? '相同' : line.status === 'changed' ? `不同（${line.fields.join('、')}，${line.diffs} 处）` : `不能回放（${line.reason?.code ?? ''}）`} |`);
  return `${out.join('\n')}\n`;
}
