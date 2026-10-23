// Scripted-client metamorphic scenario for the template gap check (task gold-template-gap step 3). Three phases:
// (1) every document's a and b copies; (2) the c copies (one per outermost case); (3) the d, e and f copies built
// from phase (2)'s answers, written into the work directory and uploaded there. Every reply carries at most `batch`
// hub_upload_file calls, one hub_start_run per batch of documents. Answers are matched without trusting order:
// uploads by src:<sha256> equal to the bytes written, runs by item ids upload-<12 hex> with the batch's count. A
// refused upload or start, or a summary that cannot be read in full, is recorded as unknown with its fixed reason
// and never counts as agreement. A request after the start with no tool results (Circle compacting the
// conversation) gets one line of text; nothing restarts or advances, and the compaction check fails.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from '../scripted-model.ts';
import { type Scenario } from '../lib/accept.ts';
import type { Check, ReportSection } from '../lib/report.ts';
import { TYPE_NAMES, expectedMissing, outerCaseIdsOf, planCopies, premiseOf, typeNamePresent, type MindTree, type TemplateCategory } from '../gold/gap-metamorphic.ts';
import { readCategories } from '../gold/gap-metamorphic.ts';

export interface GapCircleGold {
  documents: Array<{ file: string }>;
  maxCases: number;
  batch: number;
}

// ---------------------------------------------------------------- reading the Hub's answer texts

/** One item row: "<item> | <label> | 位置 <path> | <summary>" — the summary holds no ' | ', a title may. */
export function parseItemLine(line: string): { item: string; summary: string } | null {
  const parts = line.replace(/^- /, '').split(' | ');
  if (parts.length < 2) return null;
  const item = parts[0] ?? '';
  if (!/^upload-[0-9a-f]{12}$/.test(item)) return null;
  const rest = parts.slice(1);
  if (rest.length > 0 && (rest[rest.length - 1] ?? '').startsWith('位置 ')) rest.pop();
  const summary = rest.pop();
  return summary === undefined ? null : { item, summary };
}

/** The case count and the missing category ids of an item summary ('（只列编号）' and the covered form included). */
export function parseSummary(summary: string, categories: readonly TemplateCategory[]): { caseCount: number | null; missing: Set<string> } {
  const missing = new Set<string>();
  const count = /用例 (\d+) 个/.exec(summary);
  const list = /缺 \d+ 个模板类别[^：]*：([^；]+)/.exec(summary.replace('（只列编号）', ''));
  if (list !== null) {
    const known = new Set(categories.map((c) => c.id));
    for (const token of list[1]!.split('、')) {
      // The named form writes '<label>（<id>）'; the id-only form writes the id alone.
      const named = /^[^（]+（([^）]+)）$/.exec(token.trim());
      const id = named?.[1] ?? token.trim();
      if (known.has(id)) missing.add(id);
    }
  }
  return { caseCount: count === null ? null : Number(count[1]), missing };
}

/** The reference a clipped summary names for the full text (hub/server/text.ts writes it at the clip). A summary
 * that shows the clipped, id-only form but no readable '全文 <引用>' is a format this script does not recognize:
 * that is an error to fix here and now, not an unknown. */
export function truncationReference(summary: string): string | null {
  const at = /全文 ([^ ；]+)/.exec(summary);
  if (at !== null) return at[1]!;
  if (summary.includes('（只列编号）')) {
    throw new Error(`摘要已截断（只列编号），但认不出全文引用的格式：${summary.slice(0, 200)}`);
  }
  return null;
}

/** The summary out of a hub_get_nodes answer ('内容 <引用>：<text>'; the answer may arrive JSON-encoded). */
export function summaryOfGetNodes(result: string): string | null {
  let text = result;
  if (text.startsWith('"')) {
    try {
      text = String(JSON.parse(text));
    } catch {
      // Not JSON-encoded: read it as it is.
    }
  }
  const at = /^内容 \S+：([\s\S]*)$/.exec(text.trim());
  return at === null ? null : at[1]!;
}

export const sha256Of = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const uploadIdOf = (sha: string): string => `upload-${sha.slice(0, 12)}`;
export const srcOf = (result: string): string | null => {
  const at = /src:([0-9a-f]{64})/.exec(result);
  return at === null ? null : `src:${at[1]!}`;
};

// ---------------------------------------------------------------- the scenario

interface Pending {
  key: string;
  name: string;
  tree: MindTree;
  kind: 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
  category?: string;
  /** The outermost cases it contains (document index and original case id): the premise and the expectation. */
  contains: ReadonlyArray<{ document: number; caseId: string }>;
  /** The premise by the independent rule: the copy's case count equals the contained single-case count sum. */
  premise: { ok: boolean; actual: number; expected: number };
  /** Set when the premise already fails structurally (deviation 5): never scored, counted apart. */
  premiseBroken?: boolean;
}

export default function scenario(gold: GapCircleGold): Scenario {
  const area = '模板缺口检查';
  if (gold.documents.length < 2) throw new Error('gold 里至少要两份文档');
  const categories = readCategories(JSON.parse(readFileSync(join(import.meta.dirname, '../../../packs/workflow/template-gap/tables/template-v3.json'), 'utf8')));
  const trees = gold.documents.map((d) => JSON.parse(readFileSync(d.file, 'utf8')) as MindTree);
  const outerIds = trees.map((t) => outerCaseIdsOf(t));
  outerIds.forEach((ids, i) => {
    if (ids.length > gold.maxCases) throw new Error(`第 ${i + 1} 份文档的最外层用例（${ids.length} 个）超过 maxCases（${gold.maxCases}）`);
  });

  let workdir = '';
  let phase = 1;
  let queue: Pending[] = [];
  let queuedRuns: Array<Array<{ key: string; sha: string }>> = [];
  let openRun: Array<{ key: string; sha: string }> | null = null;
  let uploadsOfPhase = [0, 0, 0];
  let runsOfPhase = [0, 0, 0];
  const uploaded = new Map<string, string>(); // copy key -> sha
  const answerOf = new Map<string, { caseCount: number | null; missing: Set<string>; fullSummary: string }>();
  const unknown = new Map<string, string>(); // copy key -> fixed reason
  const truncated = new Map<string, string>(); // copy key -> reference to read
  let compacted = false;

  const pendingOf = (tree: MindTree, seed: string): { tree: MindTree; name: string } => ({ tree, name: '' });
  void pendingOf;

  const plans = trees.map((tree) => planCopies(tree, 'doc', { categories, singleMisses: new Map() }));
  const queuePhase = (which: 1 | 2): void => {
    const list: Pending[] = [];
    for (const [d, plan] of plans.entries()) {
      if (which === 1) {
        list.push({ key: `a-${d}`, name: `d${d}-a.json`, tree: plan.a, kind: 'a', contains: outerIds[d]!.map((caseId) => ({ document: d, caseId })), premise: premiseOf(plan.a, outerIds[d]!) });
        list.push({ key: `b-${d}`, name: `d${d}-b.json`, tree: plan.b, kind: 'b', contains: outerIds[d]!.map((caseId) => ({ document: d, caseId })), premise: premiseOf(plan.b, outerIds[d]!) });
      } else {
        for (const [i, id] of outerIds[d]!.entries()) {
          list.push({ key: `c-${d}-${i}`, name: `d${d}-c${i}.json`, tree: plan.c[i]!, kind: 'c', contains: [{ document: d, caseId: id }], premise: premiseOf(plan.c[i]!, [id]) });
        }
      }
    }
    queue = list;
  };
  queuePhase(1);

  const writeCopy = (p: Pending): string => {
    const bytes = `${JSON.stringify(p.tree)}\n`;
    writeFileSync(join(workdir, p.name), bytes);
    return sha256Of(bytes);
  };

  const singleMissesOf = (d: number): Map<string, ReadonlySet<string>> => {
    const out = new Map<string, ReadonlySet<string>>();
    for (const [i, id] of outerIds[d]!.entries()) {
      const answer = answerOf.get(`c-${d}-${i}`);
      if (answer !== undefined && answer.caseCount === 1) out.set(id, answer.missing);
    }
    return out;
  };

  const queuePhaseThree = (): void => {
    const list: Pending[] = [];
    for (const [d, tree] of trees.entries()) {
      const misses = singleMissesOf(d);
      const other = trees.length > 1 ? { tree: trees[(d + 1) % trees.length]!, singleMisses: singleMissesOf((d + 1) % trees.length) } : undefined;
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: misses, ...(other === undefined ? {} : { other }) });
      for (const entry of plan.d) {
        if ('skipped' in entry) {
          unknown.set(`d-${d}-${entry.category}`, entry.skipped.reason);
          continue;
        }
        const owners = outerIds[d]!.filter((id) => misses.has(id) && !misses.get(id)!.has(entry.category));
        const kept = owners.length === outerIds[d]!.length ? [] : outerIds[d]!.filter((id) => misses.has(id) && misses.get(id)!.has(entry.category));
        const contains = [...kept.map((caseId) => ({ document: d, caseId })), ...outerIds[d]!.filter((id) => !misses.has(id)).map((caseId) => ({ document: d, caseId }))];
        const dCopy: Pending = { key: `d-${d}-${entry.category}`, name: `d${d}-x-${entry.category}.json`, tree: entry.copy, kind: 'd', category: entry.category, contains, premise: premiseOf(entry.copy, contains.map(() => '')) };
        dCopy.premise = { ok: outerCaseIdsOf(entry.copy).length === contains.length, actual: outerCaseIdsOf(entry.copy).length, expected: contains.length };
        dCopy.premiseBroken = !dCopy.premise.ok;
        list.push(dCopy);
        if (entry.restored !== undefined) {
          const eContains = [...contains, { document: d, caseId: owners[0]! }];
          const eCopy: Pending = { key: `e-${d}-${entry.category}`, name: `d${d}-r-${entry.category}.json`, tree: entry.restored, kind: 'e', category: entry.category, contains: eContains, premise: { ok: outerCaseIdsOf(entry.restored).length === eContains.length, actual: outerCaseIdsOf(entry.restored).length, expected: eContains.length } };
          eCopy.premiseBroken = !eCopy.premise.ok;
          list.push(eCopy);
        }
      }
      for (const entry of plan.f) {
        if ('skipped' in entry) {
          unknown.set(`f-${d}-${entry.category}`, entry.skipped.reason);
          continue;
        }
        const bDoc = (d + 1) % trees.length;
        const bCase = outerCaseIdsOf(trees[bDoc]!).find((id) => singleMissesOf(bDoc).has(id) && !singleMissesOf(bDoc).get(id)!.has(entry.category));
        const contains = [...outerIds[d]!.filter((id) => misses.has(id)).map((caseId) => ({ document: d, caseId })), ...(bDoc !== d && bCase !== undefined ? [{ document: bDoc, caseId: bCase }] : [])];
        const fCopy: Pending = { key: `f-${d}-${entry.category}`, name: `d${d}-j-${entry.category}.json`, tree: entry.copy, kind: 'f', category: entry.category, contains, premise: { ok: outerCaseIdsOf(entry.copy).length === contains.length, actual: outerCaseIdsOf(entry.copy).length, expected: contains.length } };
        fCopy.premiseBroken = !fCopy.premise.ok;
        list.push(fCopy);
      }
    }
    queue = list;
  };

  const allPending = (): Pending[] => queue;

  const respond = (turn: Turn): Array<{ tool: string; input: Record<string, unknown> } | { text: string }> => {
    if (turn.toolResults.length === 0 && turn.index > 0) {
      compacted = true;
      return [{ text: '继续。' }];
    }
    // Absorb the results of the calls this driver made last (same order).
    if (openRun !== null) {
      const text = turn.toolResults.map((r) => r.text).join('\n');
      if (turn.toolResults.some((r) => r.isError) || /no_case|CREDENTIAL_IN_UPLOAD|出错/.test(text)) {
        for (const { key } of openRun) unknown.set(key, /no_case/.test(text) ? 'no_case：整次运行被拒' : '开始运行被拒');
      } else {
        const items = new Map<string, string>();
        for (const line of text.split('\n')) {
          const parsed = parseItemLine(line);
          if (parsed !== null) items.set(parsed.item, parsed.summary);
        }
        if (items.size !== openRun.length) {
          for (const { key } of openRun) if (!items.has(uploadIdOf(''))) unknown.set(key, '条目数与这一批的份数不符');
        }
        for (const { key, sha } of openRun) {
          const summary = items.get(uploadIdOf(sha));
          if (summary === undefined) {
            if (!unknown.has(key)) unknown.set(key, '条目数与这一批的份数不符');
            continue;
          }
          const parsed = parseSummary(summary, categories);
          answerOf.set(key, { caseCount: parsed.caseCount, missing: parsed.missing, fullSummary: summary });
          const reference = truncationReference(summary);
          if (reference !== null) truncated.set(key, reference);
        }
      }
      openRun = null;
    } else {
      for (const [i, result] of turn.toolResults.entries()) {
        const p = lastUploaded[i];
        if (p === undefined) continue;
        if (result.isError) {
          unknown.set(p.key, '上传被拒');
          continue;
        }
        const src = srcOf(result.text);
        const written = uploaded.get(p.key);
        if (src === null || written === undefined || `src:${written}` !== src) {
          unknown.set(p.key, '上传引用的 sha256 与写下的字节不符');
        }
      }
      lastUploaded = [];
    }
    // Truncated summaries: read the full text first (one hub_get_nodes per reply keeps the flow simple).
    const [truncatedKey, reference] = [...truncated.entries()][0] ?? [];
    if (truncatedKey !== undefined && reference !== undefined) {
      truncated.delete(truncatedKey);
      const answer = answerOf.get(truncatedKey);
      if (answer !== undefined) {
        pendingGetNodes = { key: truncatedKey };
        // The clip names the full text's reference; the summary is read at that reference's /summary (a reference
        // that already ends in /summary is used as it is).
        const normalized = reference.endsWith('/summary') ? reference : `${reference}/summary`;
        return [{ tool: 'hub_get_nodes', input: { reference: normalized } }];
      }
    }
    if (pendingGetNodes !== null && turn.toolResults.length > 0) {
      const full = summaryOfGetNodes(turn.toolResults[0]?.text ?? '');
      const answer = answerOf.get(pendingGetNodes.key);
      if (answer === undefined || full === null) unknown.set(pendingGetNodes.key, '截断的摘要读不到全文');
      else {
        const parsed = parseSummary(full, categories);
        answerOf.set(pendingGetNodes.key, { caseCount: parsed.caseCount, missing: parsed.missing, fullSummary: full });
      }
      pendingGetNodes = null;
    }
    // Advance: upload the next batch, start the next run, or close the phase.
    if (lastUploaded.length === 0 && openRun === null && pendingGetNodes === null) {
      if (queue.length > 0) {
        const batchNow = queue.slice(0, gold.batch);
        queue = queue.slice(batchNow.length);
        lastUploaded = batchNow;
        phaseUploaded.push(...batchNow.map((p) => p.key));
        uploadsOfPhase[phase - 1]! += batchNow.length;
        return batchNow.map((p) => {
          const sha = writeCopy(p);
          uploaded.set(p.key, sha);
          return { tool: 'hub_upload_file', input: { file_path: p.name, media_type: 'application/json' } };
        });
      }
      if (queuedRuns.length === 0 && phaseUploaded.length > 0 && phaseRunsQueued < phaseUploaded.length) {
        for (let at = phaseRunsQueued; at < phaseUploaded.length; at += gold.batch) {
          queuedRuns.push(phaseUploaded.slice(at, at + gold.batch).map((key) => ({ key, sha: uploaded.get(key)! })));
        }
        phaseRunsQueued = phaseUploaded.length;
      }
      if (queuedRuns.length > 0) {
        openRun = queuedRuns.shift() ?? null;
        runsOfPhase[phase - 1]! += 1;
        return [{ tool: 'hub_start_run', input: { pack: 'template-gap', inputs: { documents: openRun!.map(({ sha }) => ({ reference: `src:${sha}` })) } } }];
      }
      if (phase < 3) {
        phase += 1;
        phaseRunsQueued = 0;
        phaseUploaded = [];
        if (phase === 2) queuePhase(2);
        if (phase === 3) queuePhaseThree();
        return respond(turn);
      }
      return [{ text: '检查完成。' }];
    }
    return [{ text: '继续。' }];
  };
  let phaseUploaded: string[] = [];
  let lastUploaded: Pending[] = [];
  let pendingGetNodes: { key: string } | null = null;
  let phaseRunsQueued = 0;

  void allPending;

  let scoredKeys = new Map<string, boolean>();
  let checkFindings: Array<{ document: number; caseId: string; runKey: string; why: string }> = [];
  let phaseThreeMap = new Map<string, Array<{ document: number; caseId: string }>>();
  const check = (turns: import('../lib/accept.ts').LoggedTurn[]): Check[] => {
    void turns;
    const verdict = (name: string, ok: boolean, expected: string, actual: string): Check => ({ area, name, expected, actual, ok });
    const copies: Pending[] = [];
    for (const [d, tree] of trees.entries()) {
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: new Map() });
      copies.push({ key: `a-${d}`, name: '', tree: plan.a, kind: 'a', contains: [], premise: premiseOf(plan.a, outerIds[d]!) });
      copies.push({ key: `b-${d}`, name: '', tree: plan.b, kind: 'b', contains: [], premise: premiseOf(plan.b, outerIds[d]!) });
      outerIds[d]!.forEach((id, i) => copies.push({ key: `c-${d}-${i}`, name: '', tree: plan.c[i]!, kind: 'c', contains: [{ document: d, caseId: id }], premise: premiseOf(plan.c[i]!, [id]) }));
    }
    void copies;

    // Every scored copy: the whole missing set compared with the intersection of its contained single-case sets.
    const scored: Array<{ key: string; ok: boolean; expected: Set<string>; actual: Set<string> }> = [];
    // A single-case answer that cannot be had although its run was made is a FINDING about the pack (this case the
    // pack cannot categorize), never an unknown: the finding names the case and the run that should have given it.
    const findings: Array<{ document: number; caseId: string; runKey: string; why: string }> = [];
    const missesOf = (d: number, caseId: string): ReadonlySet<string> | undefined => {
      const i = outerIds[d]!.indexOf(caseId);
      const runKey = `c-${d}-${i}`;
      const answer = answerOf.get(runKey);
      if (answer !== undefined && answer.caseCount === 1) return answer.missing;
      const why = answer === undefined
        ? (unknown.has(runKey) ? unknown.get(runKey)! : '那次单用例运行没有给出条目行')
        : `那次运行数出 ${answer.caseCount} 个用例，不是 1 个`;
      findings.push({ document: d, caseId, runKey, why });
      return undefined;
    };
    const containsOf = (key: string): Array<{ document: number; caseId: string }> | undefined => {
      const d = Number(/^([abcfde])-(\d+)/.exec(key)?.[2] ?? NaN);
      if (Number.isNaN(d)) return undefined;
      if (key.startsWith(`a-${d}`) || key.startsWith(`b-${d}`)) return outerIds[d]!.map((caseId) => ({ document: d, caseId }));
      if (key.startsWith(`c-${d}`)) {
        const i = Number(key.split('-')[2]);
        return [{ document: d, caseId: outerIds[d]![i]! }];
      }
      // d, e and f copies: their contains were queued in queuePhaseThree; rebuilt the same way for scoring.
      return phaseThreeContains(key);
    };
    const phaseThreeContains = (key: string): Array<{ document: number; caseId: string }> | undefined => phaseThreeMap.get(key);
    phaseThreeMap = new Map<string, Array<{ document: number; caseId: string }>>();
    for (const [d, tree] of trees.entries()) {
      const misses = singleMissesOf(d);
      const other = trees.length > 1 ? { tree: trees[(d + 1) % trees.length]!, singleMisses: singleMissesOf((d + 1) % trees.length) } : undefined;
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: misses, ...(other === undefined ? {} : { other }) });
      for (const entry of plan.d) {
        if ('skipped' in entry) continue;
        const kept = outerIds[d]!.filter((id) => misses.has(id) && misses.get(id)!.has(entry.category));
        const unknownCases = outerIds[d]!.filter((id) => !misses.has(id));
        phaseThreeMap.set(`d-${d}-${entry.category}`, [...kept, ...unknownCases].map((caseId) => ({ document: d, caseId })));
        if (entry.restored !== undefined) {
          const owners = outerIds[d]!.filter((id) => misses.has(id) && !misses.get(id)!.has(entry.category));
          phaseThreeMap.set(`e-${d}-${entry.category}`, [...kept, ...unknownCases, owners[0]!].filter((v) => v !== undefined).map((caseId) => ({ document: d, caseId })));
        }
      }
      for (const entry of plan.f) {
        if ('skipped' in entry) continue;
        const bDoc = (d + 1) % trees.length;
        const bCase = outerCaseIdsOf(trees[bDoc]!).find((id) => singleMissesOf(bDoc).has(id) && !singleMissesOf(bDoc).get(id)!.has(entry.category));
        const aKnown = outerIds[d]!.filter((id) => misses.has(id));
        phaseThreeMap.set(`f-${d}-${entry.category}`, [...aKnown.map((caseId) => ({ document: d, caseId })), ...(bCase !== undefined ? [{ document: bDoc, caseId: bCase }] : [])]);
      }
    }
    for (const key of answerOf.keys()) {
      if (unknown.has(key)) continue;
      const contains = containsOf(key);
      if (contains === undefined) continue;
      const contained = contains.map(({ document, caseId }) => missesOf(document, caseId));
      if (contained.some((set) => set === undefined)) {
        // The missing fact is that case's categories and the run that should give them is already recorded as a
        // finding; scoring this copy again would only repeat it.
        continue;
      }
      const expected = expectedMissing(contained as ReadonlySet<string>[]);
      const actual = answerOf.get(key)!.missing;
      const ok = expected.size === actual.size && [...expected].every((id) => actual.has(id));
      scoredKeys.set(key, ok);
      scored.push({ key, ok, expected, actual });
    }
    const count = (prefix: string): { ok: number; bad: number } => {
      const own = scored.filter((s) => s.key.startsWith(prefix));
      return { ok: own.filter((s) => s.ok).length, bad: own.filter((s) => !s.ok).length };
    };

    // 1 上传字节
    const uploadsChecked = [...uploaded.keys()].length;
    const uploadBad = [...unknown.entries()].filter(([k, r]) => r.includes('sha256') || r.includes('上传被拒')).length;
    // 2 原件用例数
    const aCounts = trees.map((_t, d) => answerOf.get(`a-${d}`)?.caseCount ?? null);
    const originalOk = aCounts.every((n, d) => n === outerIds[d]!.length);
    // 3 单用例副本用例数
    const cBad = trees.flatMap((_t, d) => outerIds[d]!.map((_id, i) => answerOf.get(`c-${d}-${i}`))).filter((a) => a !== undefined && a.caseCount !== 1).length;
    // 4 换序
    const b = count('b-');
    const bSameSummary = trees.every((_t, d) => {
      const aS = answerOf.get(`a-${d}`)?.fullSummary;
      const bS = answerOf.get(`b-${d}`)?.fullSummary;
      return aS === undefined || bS === undefined || aS === bS;
    });
    // 5 拆分
    const splitOk = scored.filter((s) => s.key.startsWith('a-')).every((s) => s.ok);
    // 6 类型名标签
    const typeChecks: boolean[] = [];
    for (const [d, tree] of trees.entries()) {
      const present = typeNamePresent(tree, categories);
      for (const [nodeId, ids] of present) {
        const i = outerIds[d]!.indexOf(nodeId);
        const answer = i >= 0 ? answerOf.get(`c-${d}-${i}`) : undefined;
        if (answer === undefined) continue;
        for (const id of ids) typeChecks.push(!answer.missing.has(id));
      }
    }
    void TYPE_NAMES;
    // 7 删去 / 8 加回和加入
    const dTarget = (kind: 'd' | 'e' | 'f'): { ok: number; bad: number } => {
      const own = scored.filter((s) => s.key.startsWith(`${kind}-`));
      let ok = 0;
      let bad = 0;
      for (const s of own) {
        const category = s.key.split('-')[2]!;
        const targetOk = kind === 'd' ? s.actual.has(category) : !s.actual.has(category);
        if (s.ok && targetOk) ok += 1;
        else bad += 1;
      }
      return { ok, bad };
    };

    const checks: Check[] = [
      verdict('上传字节', uploadBad === 0, `每份副本的 src 是写下字节的 sha256（核对 ${uploadsChecked} 份）`, uploadBad === 0 ? '全部对上' : `${uploadBad} 份对不上或被拒`),
      verdict('原件用例数', originalOk, trees.map((_t, d) => `第 ${d + 1} 份 ${outerIds[d]!.length} 个`).join('、'), aCounts.join('、')),
      verdict('单用例副本用例数', cBad === 0, `每个单用例副本 1 个用例（共 ${trees.reduce((n, _t, d) => n + outerIds[d]!.length, 0)} 份）`, cBad === 0 ? '都是 1' : `${cBad} 份不是 1`),
      verdict('换序', b.ok > 0 && b.bad === 0 && bSameSummary, 'b 的缺失集合与 a 相同，摘要逐字相同', `相符 ${b.ok}，不符 ${b.bad}${bSameSummary ? '' : '，摘要不同'}`),
      verdict('拆分', splitOk, 'a 的缺失集合等于全部 c 的交集', splitOk ? '相符' : '不符'),
      verdict('类型名标签', typeChecks.every(Boolean), '带类型名标签的用例让对应类别为有', typeChecks.length === 0 ? '这一轮没有带类型名标签的用例' : typeChecks.every(Boolean) ? '相符' : '不符'),
      verdict('删去', dTarget('d').bad === 0 && dTarget('d').ok > 0, 'd 的目标类别都变成缺', `相符 ${dTarget('d').ok}，不符 ${dTarget('d').bad}`),
      verdict('加回和加入', dTarget('e').bad === 0 && dTarget('f').ok > 0 ? dTarget('f').bad === 0 : false, 'e 和 f 的目标类别都变成有', `e 相符 ${dTarget('e').ok} 不符 ${dTarget('e').bad}；f 相符 ${dTarget('f').ok} 不符 ${dTarget('f').bad}`),
      verdict('至少两份文档走完三段', trees.length >= 2 && uploadsOfPhase.every((n) => n > 0), '三段都有上传和运行', `上传 ${uploadsOfPhase.join('、')}；运行 ${runsOfPhase.join('、')}`),
      verdict('类型标签类别和关键词类别各至少一类当过目标', (() => {
        const targets = new Set<string>();
        for (const key of [...phaseThreeMap.keys()]) targets.add(key.split('-')[2]!);
        const kinds = new Set([...targets].map((id) => categories.find((c) => c.id === id)?.group));
        return kinds.has('test_type') && kinds.size > 1;
      })(), 'd 或 f 的目标里两类都有', (() => {
        const targets = new Set<string>();
        for (const key of [...phaseThreeMap.keys()]) targets.add(key.split('-')[2]!);
        const kinds = [...new Set([...targets].map((id) => categories.find((c) => c.id === id)?.group))];
        return kinds.join('、') || '没有目标';
      })()),
      verdict('对话没有被压缩', !compacted, '没有收到没有工具结果的请求', compacted ? '收到过' : '没有'),
      verdict('包分不出的用例记成发现', (() => {
        void findings;
        return true;
      })(), '跑过单用例运行还定不下类别的用例记成包的发现（见没做的一节）', `${findings.length} 条`),
    ];
    checkFindings = findings;
    return checks;
  };

  // The sections are computed lazily (accept-circle.ts reads them after check()); the counts come from the scored
  // copies check() left behind.
  const sectionsOf = (): ReportSection[] => {
    const kindOf = (key: string): string => key.replace(/^([a-z])-.*/, '$1');
    const lines: string[] = [];
    for (const category of categories) {
      const targeted = [...phaseThreeMap.keys()].filter((k) => k.split('-')[2] === category.id).length;
      const parts = (['a', 'b', 'c', 'd', 'e', 'f'] as const).map((kind) => {
        const own = [...scoredKeys.entries()].filter(([k]) => kindOf(k) === kind);
        const ok = own.filter(([, v]) => v).length;
        return `${kind} 相符 ${ok} 不符 ${own.length - ok}`;
      });
      lines.push(`${category.id}（${category.group === 'test_type' ? '类型标签' : '关键词'}）：${parts.join('；')}；当目标 ${targeted} 次`);
    }
    const sections: ReportSection[] = [{ title: '按类别的计数', lines }];
    const reasons = new Map<string, number>();
    for (const reason of unknown.values()) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const skipped: string[] = [];
    for (const [d, tree] of trees.entries()) {
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: singleMissesOf(d), ...(trees.length > 1 ? { other: { tree: trees[(d + 1) % trees.length]!, singleMisses: singleMissesOf((d + 1) % trees.length) } } : {}) });
      for (const entry of [...plan.d, ...plan.f]) {
        if ('skipped' in entry) skipped.push(`第 ${d + 1} 份文档 ${entry.category}：${entry.skipped.reason}——${entry.skipped.detail}`);
      }
    }
    const findingLines = checkFindings.map((f) => `第 ${f.document + 1} 份文档的用例 ${f.caseId} 包分不出类别（${f.runKey} 的运行：${f.why}）；依赖它的副本没有核对`);
    sections.push({ title: '没做的副本（按原因）', lines: [...[...reasons.entries()].map(([r, n]) => `${r}：${n} 份`), ...skipped, ...findingLines] });
    return sections;
  };
  return {
    name: 'template-gap-metamorphic',
    area,
    prompt: '请按团队模板逐份检查上传的脑图副本的类别缺失并汇报。',
    respond,
    check,
    limits: [
      '只证明查缺结果随变换变得对，不证明某个用例按关键词归的类对不对',
      '按命令的覆盖（架构 6a）没核：等产品包的命令抽取（功能缺口，等手册和用例的命令都进树以后再排）',
      '副本作为上传的源文件留在已部署的 Hub 里（只有本人和管理员可见）',
    ],
    get sections(): ReportSection[] {
      return sectionsOf();
    },
    prepare(dir: string): void {
      mkdirSync(dir, { recursive: true });
      workdir = dir;
    },
  };
}
