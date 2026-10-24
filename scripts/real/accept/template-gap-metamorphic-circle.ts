// Scripted-client metamorphic scenario for the template gap check (task gold-template-gap step 3). Three phases:
// (1) every document's a and b copies; (2) the c copies (one per outermost case); (3) the d, e and f copies built
// from phase (2)'s answers, written into the work directory and uploaded there. Every reply carries at most `batch`
// hub_upload_file calls, one hub_start_run per batch of documents. Answers are matched without trusting order:
// uploads by src:<sha256> equal to the bytes written, runs by item ids upload-<12 hex> with the batch's count. A
// refused upload or start, or a summary that cannot be read in full, is recorded as unknown with its fixed reason
// and never counts as agreement. A request after the start with no tool results (Circle compacting the
// conversation) gets one line of text; nothing restarts or advances, and the compaction check fails.
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from '../scripted-model.ts';
import { type Scenario } from '../lib/accept.ts';
import type { Check, ReportSection } from '../lib/report.ts';
import { caseCountOf, typeNamesInCase, expectedMissing, outerCaseKeysOf as outerCaseIdsOf, planCopies, premiseOf, typeNamePresent, type MindTree, type TemplateCategory, type SkipReason } from '../gold/gap-metamorphic.ts';
import { readCategories } from '../gold/gap-metamorphic.ts';
import { contentHeader } from './content-header.ts';

const skipActions: Record<SkipReason['reason'],string> = {
  '前提不成立':'下一步换用保持用例边界且满足该变换前提的文档或类别后重新生成副本',
  'X 在每个最外层用例上都有':'下一步换用该类别满足删除变换前提的文档',
  '没有单用例副本显示 X':'下一步换用该类别满足供体变换前提的文档',
  '单用例副本答案未知':'下一步重读或重跑第 2 段缺答案的单用例副本，补齐后重跑第 3 段',
};

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
export function parseSummary(summary: string, categories: readonly TemplateCategory[]): { caseCount: number | null; missing: Set<string>; valid: boolean } {
  const missing = new Set<string>(); const count = /用例 (\d+) 个/.exec(summary);
  const list = /缺 (\d+) 个模板类别[^：]*：([^；]+)/.exec(summary.replace('（只列编号）', ''));
  const known = new Set(categories.map(category => category.id)); let valid = false;
  if (list) {
    const tokens = list[2]!.split('、').map(token => /^[^（]+（([^）]+)）$/.exec(token.trim())?.[1] ?? token.trim());
    tokens.forEach(id => { if (known.has(id)) missing.add(id); });
    valid = tokens.every(id => known.has(id)) && tokens.length === Number(list[1]) && missing.size === Number(list[1]);
  } else {
    const covered = /([0-9]+) 个模板类别都已覆盖/.exec(summary);
    valid = covered !== null && Number(covered[1]) === categories.length;
  }
  const caseCount = count ? Number(count[1]) : null;
  return { caseCount, missing, valid: valid && caseCount !== null && Number.isSafeInteger(caseCount) && !summary.includes('…（共') };
}

/** The reference a clipped summary names for the full text (hub/server/text.ts writes it at the clip). A summary
 * that shows the clipped, id-only form but no readable '全文 <引用>' is a format this script does not recognize:
 * that is an error to fix here and now, not an unknown. */
export class SummaryReadRefusal extends Error {
  readonly reason = 'summary_reference_missing' as const;
  constructor(){super('摘要已截断但认不出全文引用；下一步重读该运行记录的条目摘要，补全文引用格式后重新读取');this.name='SummaryReadRefusal';}
}

export function truncationReference(summary: string): string | null {
  const at = /全文 (rec:[0-9a-f]{64}#\/items\/[0-9]+)(?=）)/.exec(summary);
  if (at !== null) return at[1]!;
  if (/…（共 [0-9]+ 个字符/.test(summary)) {
    throw new SummaryReadRefusal();
  }
  return null;
}

/** The summary out of a hub_get_nodes answer ('内容 <引用>：<text>'; the answer may arrive JSON-encoded). */
export function summaryOfGetNodes(result: string, expectedReference?: string): string | null {
  return readSummary(result, expectedReference).summary;
}

function readSummary(result: string, expectedReference?: string): { summary: string | null; missing: string } {
  const refuse = (missing: string) => ({ summary: null, missing });
  const head = contentHeader(result);
  if (!head) return refuse('缺少仅带已知客户端前言的 Hub 内容头');
  if (expectedReference !== undefined && head.reference !== expectedReference) return refuse('缺少所请求摘要引用的读取结果');
  if (head.tier !== labelOf('read_tier', 'model_readable')) return refuse('缺少模型可读的摘要全文');
  const lines = head.lines;
  const count = /^原文（([0-9]+) 个字符）：$/.exec(lines[1] ?? '');
  if (count) {
    const end = lines.findIndex((line, index) => index > 1 && line.startsWith('追踪 '));
    if (end < 0) return refuse('缺少摘要全文结束的追踪标记');
    const summary = lines.slice(2, end).join('\n');
    if (!Number.isSafeInteger(Number(count[1])) || summary.length !== Number(count[1])) return refuse(`缺少与原文声明 ${count[1]} 个字符一致的完整摘要（实际 ${summary.length} 个字符）`);
    return summary.startsWith('用例 ') ? { summary, missing: '' } : refuse('缺少以用例计数开头的摘要全文');
  }
  const candidates: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('追踪 ')) break;
    if (line.startsWith('"')) { try { const value: unknown = JSON.parse(line); if (typeof value === 'string') candidates.push(value); } catch { return refuse('缺少可解析的摘要字符串'); } }
    else if (line.startsWith('用例 ')) candidates.push(line);
  }
  return candidates.length === 1 ? { summary: candidates[0]!, missing: '' } : refuse('缺少唯一的摘要全文');
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
  const refused = (message: string, action: string): Scenario => ({ name: 'template-gap-metamorphic', area, prompt: '输入前提未满足，不执行工具调用', respond: () => [{ text: `输入前提不符：${message}；下一步：${action}` }], check: () => [{ area, name: '输入前提', ok: false, expected: action, actual: message }], sections: [{ title: '没做的副本（按原因）', lines: [`输入前提不符：${message}；下一步：${action}`] }] });
  if (!gold || typeof gold !== 'object' || !Array.isArray(gold.documents) || gold.documents.length < 2) return refused('documents 至少要两份文档', '提供 documents 数组，至少两份可读的原始脑图 JSON');
  if (!Number.isSafeInteger(gold.batch) || gold.batch < 1) return refused('batch 必须为至少 1 的整数', '提供正整数 batch');
  if (!Number.isSafeInteger(gold.maxCases) || gold.maxCases < 1) return refused('maxCases 必须为至少 1 的整数', '提供正整数 maxCases');
  const trees: MindTree[] = []; const outerIds: string[][] = [];
  for (const [document, entry] of gold.documents.entries()) {
    if (!entry || typeof entry.file !== 'string' || !entry.file) return refused(`documents 第 ${document + 1} 份缺少 file`, '提供该份原始脑图 JSON 文件');
    let tree: MindTree; let keys: string[];
    try { tree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(entry.file))) as MindTree; keys = outerCaseIdsOf(tree); }
    catch { return refused(`documents 第 ${document + 1} 份没有可读的合法脑图结构`, '补充该份可读的原始脑图 JSON'); }
    if (!keys.length) return refused(`第 ${document + 1} 份文档没有最外层用例`, '选择至少有一个最外层用例的脑图');
    if (keys.length > gold.maxCases) return refused(`第 ${document + 1} 份的用例 ${keys.length} 个超过 maxCases ${gold.maxCases}`, '提高 maxCases 或选择较小的文档');
    trees.push(tree); outerIds.push(keys);
  }
  const categories = readCategories(JSON.parse(readFileSync(join(import.meta.dirname, '../../../packs/workflow/template-gap/tables/template-v3.json'), 'utf8')));

  let workdir = '';
  let phase = 1;
  let queue: Pending[] = [];
  let queuedRuns: Array<Array<{ key: string; sha: string }>> = [];
  let openRun: Array<{ key: string; sha: string }> | null = null;
  let uploadsOfPhase = [0, 0, 0];
  let runsOfPhase = [0, 0, 0];
  const attempted = new Map<string, Pending>();
  const notDoneChecks = new Set<string>();
  const uploaded = new Map<string, string>(); // copy key -> sha
  const uploadVerdicts = new Map<string, boolean>();
  const answerOf = new Map<string, { caseCount: number | null; missing: Set<string>; fullSummary: string }>();
  const unknown = new Map<string, string>(); // copy key -> fixed reason
  const truncated = new Map<string, string>(); // copy key -> reference to read
  let compacted = false;
  let fatal: { key: string; run: number; item: number } | null = null;
  const halted = () => `核对停止：第 ${fatal!.run} 次运行，第 ${fatal!.item} 项摘要缺少可识别全文引用；下一步修复读取解析后重跑`;

  const pendingOf = (tree: MindTree, seed: string): { tree: MindTree; name: string } => ({ tree, name: '' });
  void pendingOf;

  const plans = trees.map((tree, d) => planCopies(tree, `doc${d + 1}`, { categories, singleMisses: new Map() }));
  const singleCounts = plans.map((plan, document) => new Map(outerIds[document]!.map((key, at) => [key, caseCountOf(plan.c[at]!)])));
  const copyPremise = (tree: MindTree, contains: ReadonlyArray<{ document: number; caseId: string }>) => {
    const actual = caseCountOf(tree); const expected = contains.reduce((sum, item) => sum + singleCounts[item.document]!.get(item.caseId)!, 0);
    return { actual, expected, ok: actual === expected };
  };
  const queuePhase = (which: 1 | 2): void => {
    const list: Pending[] = [];
    for (const [d, plan] of plans.entries()) {
      if (which === 1) {
        list.push({ key: `a-${d}`, name: `d${d}-a.json`, tree: plan.a, kind: 'a', contains: outerIds[d]!.map((caseId) => ({ document: d, caseId })), premise: premiseOf(plan.a, outerIds[d]!, singleCounts[d]) });
        list.push({ key: `b-${d}`, name: `d${d}-b.json`, tree: plan.b, kind: 'b', contains: outerIds[d]!.map((caseId) => ({ document: d, caseId })), premise: premiseOf(plan.b, outerIds[d]!, singleCounts[d]) });
      } else {
        const original = answerOf.get(`a-${d}`);
        if (!original || unknown.has(`a-${d}`) || original.caseCount !== caseCountOf(trees[d]!)) { unknown.set(`phase2-${d}`, `第 ${d + 1} 份原件用例数未与独立计数核对一致；没有运行单用例副本；下一步重读原件条目摘要并核对独立计数，仍不一致交集成者修正后重跑第2段`); continue; }
        for (const [i, id] of outerIds[d]!.entries()) {
          list.push({ key: `c-${d}-${i}`, name: `d${d}-c${i}.json`, tree: plan.c[i]!, kind: 'c', contains: [{ document: d, caseId: id }], premise: premiseOf(plan.c[i]!, [id], singleCounts[d]) });
        }
      }
    }
    queue = list;
  };
  queuePhase(1);

  let copyOrdinal = 0;
  const writeCopy = (p: Pending): string => {
    p.name = `${String(++copyOrdinal).padStart(5, '0')}.json`;
    const bytes = `${JSON.stringify(p.tree)}\n`;
    writeFileSync(join(workdir, p.name), bytes); attempted.set(p.key, p);
    return sha256Of(bytes);
  };

  const singleMissesOf = (d: number): Map<string, ReadonlySet<string>> => {
    const out = new Map<string, ReadonlySet<string>>();
    for (const [i, id] of outerIds[d]!.entries()) {
      const answer = answerOf.get(`c-${d}-${i}`);
      if (answer !== undefined && !unknown.has(`c-${d}-${i}`) && answer.caseCount === singleCounts[d]!.get(id)) out.set(id, answer.missing);
    }
    return out;
  };

  const requiredTypes = (document: number, key: string): ReadonlySet<string> => typeNamesInCase(trees[document]!, key, categories);

  const queuePhaseThree = (): void => {
    const list: Pending[] = [];
    for (const [d, tree] of trees.entries()) {
      const misses = singleMissesOf(d);
      const other = trees.length > 1 ? { tree: trees[(d + 1) % trees.length]!, singleMisses: singleMissesOf((d + 1) % trees.length) } : undefined;
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: misses, ...(other === undefined ? {} : { other }) });
      for (const entry of plan.d) {
        if ('skipped' in entry) {
          unknown.set(`d-${d}-${entry.category}`, entry.skipped.reason + '；' + skipActions[entry.skipped.reason]);
          continue;
        }
        const owners = outerIds[d]!.filter((id) => misses.has(id) && !misses.get(id)!.has(entry.category));
        const kept = owners.length === outerIds[d]!.length ? [] : outerIds[d]!.filter((id) => misses.has(id) && misses.get(id)!.has(entry.category));
        const contains = [...kept.map((caseId) => ({ document: d, caseId })), ...outerIds[d]!.filter((id) => !misses.has(id)).map((caseId) => ({ document: d, caseId }))];
        const dCopy: Pending = { key: `d-${d}-${entry.category}`, name: `d${d}-x-${entry.category}.json`, tree: entry.copy, kind: 'd', category: entry.category, contains, premise: copyPremise(entry.copy, contains) };
        dCopy.premise = copyPremise(entry.copy, contains);
        dCopy.premiseBroken = !dCopy.premise.ok;
        if (dCopy.premiseBroken) unknown.set(dCopy.key, '前提不成立；下一步换用保持用例边界的文档或类别后重新生成副本'); else list.push(dCopy);
        if (entry.restored !== undefined) {
          const eContains = [...contains, { document: d, caseId: owners[0]! }];
          const eCopy: Pending = { key: `e-${d}-${entry.category}`, name: `d${d}-r-${entry.category}.json`, tree: entry.restored, kind: 'e', category: entry.category, contains: eContains, premise: copyPremise(entry.restored, eContains) };
          eCopy.premiseBroken = !eCopy.premise.ok;
          if (eCopy.premiseBroken) unknown.set(eCopy.key, '前提不成立；下一步换用保持用例边界的文档或类别后重新生成副本'); else list.push(eCopy);
        }
      }
      for (const entry of plan.f) {
        if ('skipped' in entry) {
          unknown.set(`f-${d}-${entry.category}`, entry.skipped.reason + '；' + skipActions[entry.skipped.reason]);
          continue;
        }
        const bDoc = (d + 1) % trees.length;
        const bCase = outerCaseIdsOf(trees[bDoc]!).find((id) => singleMissesOf(bDoc).has(id) && !singleMissesOf(bDoc).get(id)!.has(entry.category));
        const contains = [...outerIds[d]!.filter((id) => misses.has(id)).map((caseId) => ({ document: d, caseId })), ...(bDoc !== d && bCase !== undefined ? [{ document: bDoc, caseId: bCase }] : [])];
        const fCopy: Pending = { key: `f-${d}-${entry.category}`, name: `d${d}-j-${entry.category}.json`, tree: entry.copy, kind: 'f', category: entry.category, contains, premise: copyPremise(entry.copy, contains) };
        fCopy.premiseBroken = !fCopy.premise.ok;
        if (fCopy.premiseBroken) unknown.set(fCopy.key, '前提不成立；下一步换用保持用例边界的文档或类别后重新生成副本'); else list.push(fCopy);
      }
    }
    queue = list;
  };

  const allPending = (): Pending[] => queue;

  const respond = (turn: Turn): Array<{ tool: string; input: Record<string, unknown> } | { text: string }> => {
    if (fatal) return [{ text: halted() }];
    if (turn.toolResults.length === 0 && turn.index > 0) {
      compacted = true;
      return [{ text: '继续。' }];
    }
    // Absorb the results of the calls this driver made last (same order).
    if (openRun !== null) {
      const text = turn.toolResults.map((r) => r.text).join('\n');
      if (turn.toolResults.some((r) => r.isError)) {
        const code = text.split(/\r?\n/).map(line => /^- ([A-Z_]+)：/.exec(line)?.[1]).find(code => code !== undefined && Object.hasOwn(PROTOCOL_CODES, code));
        for (const { key } of openRun) unknown.set(key, `开始运行被拒${code ? `（${code}）` : ''}；下一步核对开始运行应答的错误码和运行回执，修正输入后重跑该批`);
      } else {
        const items = new Map<string, string>();
        for (const line of text.split('\n')) {
          const parsed = parseItemLine(line);
          if (parsed !== null) items.set(parsed.item, parsed.summary);
        }
        if (items.size !== openRun.length) {
          for (const { key } of openRun) unknown.set(key, '条目数与这一批的份数不符；下一步用 get_nodes 重读该运行记录的 items，核对完整条目后缩小 batch 重跑');
        }
        for (const { key, sha } of openRun) {
          if (unknown.has(key)) continue;
          const summary = items.get(uploadIdOf(sha));
          if (summary === undefined) {
            if (!unknown.has(key)) unknown.set(key, '条目数与这一批的份数不符；下一步用 get_nodes 重读该运行记录的 items，核对完整条目后缩小 batch 重跑');
            continue;
          }
          let reference: string | null;
          try { reference = truncationReference(summary); } catch (error) { if(!(error instanceof SummaryReadRefusal))throw error; unknown.set(key, error.message); if (!fatal) fatal = { key, run: runsOfPhase.reduce((a, b) => a + b, 0), item: openRun.findIndex(copy => copy.key === key) + 1 }; continue; }
          if (reference !== null) truncated.set(key, reference);
          else { const parsed = parseSummary(summary, categories); if (!parsed.valid) unknown.set(key, '缺少可解析的用例数或完整类别集合；下一步重读对应条目的完整 summary，并核对计数与类别集合格式'); else answerOf.set(key, { caseCount: parsed.caseCount, missing: parsed.missing, fullSummary: summary }); }
        }
      }
      openRun = null;
    } else {
      const pending = new Map(lastUploaded.map(copy => [`src:${uploaded.get(copy.key)}`, copy]));
      for (const result of turn.toolResults) {
        const src = srcOf(result.text); const copy = src === null ? undefined : pending.get(src);
        if (!copy || result.isError) continue;
        uploadVerdicts.set(copy.key, true); pending.delete(src!);
      }
      for (const copy of lastUploaded) {
        if (uploadVerdicts.get(copy.key) === true) phaseUploaded.push(copy.key);
        else { uploadVerdicts.set(copy.key, false); unknown.set(copy.key, '上传被拒或未给出匹配的 sha256；下一步检查上传应答的错误码，选择无凭据文本的文档或重新上传并核对摘要'); }
      }
      lastUploaded = [];
    }
    if (fatal) return [{ text: halted() }];
    if (pendingGetNodes !== null && turn.toolResults.length > 0) {
      const read = readSummary(turn.toolResults[0]?.text ?? '', pendingGetNodes.reference);
      const full = read.summary;
      if (turn.toolResults.some(result => result.isError) || full === null) unknown.set(pendingGetNodes.key, `${turn.toolResults.some(result => result.isError) ? '缺少成功的摘要读取结果' : read.missing}；下一步用已记录的引用 ${pendingGetNodes.reference} 调用 hub_get_nodes 重读，核对原文字符数与全文一致后重跑本场景`);
      else {
        const parsed = parseSummary(full, categories);
        if (!parsed.valid) unknown.set(pendingGetNodes.key, '全文缺少可解析的用例数或完整类别集合；下一步重读已保存的全文引用并核对完整计数与类别集合，仍不符交集成者修正读取解析');
        else answerOf.set(pendingGetNodes.key, { caseCount: parsed.caseCount, missing: parsed.missing, fullSummary: full });
      }
      pendingGetNodes = null;
    }
    // Truncated summaries: read the full text first (one hub_get_nodes per reply keeps the flow simple).
    const [truncatedKey, reference] = [...truncated.entries()][0] ?? [];
    if (truncatedKey !== undefined && reference !== undefined) {
      truncated.delete(truncatedKey);
      {
        pendingGetNodes = { key: truncatedKey, reference: reference.endsWith('/summary') ? reference : `${reference}/summary` };
        // The clip names the full text's reference; the summary is read at that reference's /summary (a reference
        // that already ends in /summary is used as it is).
        const normalized = reference.endsWith('/summary') ? reference : `${reference}/summary`;
        return [{ tool: 'hub_get_nodes', input: { reference: normalized } }];
      }
    }
    // Advance: upload the next batch, start the next run, or close the phase.
    if (lastUploaded.length === 0 && openRun === null && pendingGetNodes === null) {
      if (queue.length > 0) {
        const batchNow = queue.slice(0, gold.batch);
        queue = queue.slice(batchNow.length);
        lastUploaded = batchNow;
        uploadsOfPhase[phase - 1]! += batchNow.length;
        return batchNow.map((p) => {
          const sha = writeCopy(p);
          uploaded.set(p.key, sha); uploadVerdicts.set(p.key, false);
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
  let pendingGetNodes: { key: string; reference: string } | null = null;
  let phaseRunsQueued = 0;

  void allPending;

  let categoryScores: Array<{ key: string; expected: Set<string>; actual: Set<string> }> = [];
  let scoredKeys = new Map<string, boolean>();
  let checkFindings: Array<{ document: number; caseId: string; runKey: string; why: string }> = [];
  let phaseThreeMap = new Map<string, Array<{ document: number; caseId: string }>>();
  const check = (turns: import('../lib/accept.ts').LoggedTurn[]): Check[] => {
    void turns; scoredKeys = new Map(); notDoneChecks.clear();
    const verdict = (name: string, ok: boolean, expected: string, actual: string): Check => ({ area, name, expected, actual, ok });
    const scored: Array<{ key: string; ok: boolean; expected: Set<string>; actual: Set<string> }> = [];
    const findings: typeof checkFindings = [];
    const ownerOf = (key: string) => Number(key.split('-')[1]);
    const countExpected = (key: string) => attempted.get(key)?.premise.expected ?? 1;
    const missesOf = (document: number, caseId: string): ReadonlySet<string> | undefined => {
      const ordinal = outerIds[document]!.indexOf(caseId); const key = `c-${document}-${ordinal}`; const answer = answerOf.get(key);
      if (answer && !unknown.has(key) && answer.caseCount === countExpected(key)) return answer.missing;
      if (attempted.has(key)) findings.push({ document, caseId, runKey: key, why: unknown.get(key) ?? (answer ? `数出 ${answer.caseCount} 个，独立计数为 ${countExpected(key)} 个` : '缺少完整条目结果') });
      return undefined;
    };
    phaseThreeMap = new Map([...attempted].filter(([, copy]) => ['d','e','f'].includes(copy.kind)).map(([key, copy]) => [key, [...copy.contains]]));
    for (const [key, answer] of answerOf) {
      const copy = attempted.get(key); if (!copy || unknown.has(key)) continue;
      let expected: Set<string>;
      if (copy.kind === 'b') {
        const original = answerOf.get(`a-${ownerOf(key)}`); if (!original || unknown.has(`a-${ownerOf(key)}`)) continue;
        expected = new Set(original.missing);
      } else if (copy.kind === 'c') {
        if (answer.caseCount !== countExpected(key)) { copy.contains.forEach(item => missesOf(item.document, item.caseId)); continue; }
        expected = new Set(answer.missing);
        for (const id of requiredTypes(ownerOf(key), copy.contains[0]!.caseId)) expected.delete(id);
      } else {
        const sets = copy.contains.map(item => missesOf(item.document, item.caseId));
        if (sets.some(set => set === undefined)) continue;
        expected = expectedMissing(sets as ReadonlySet<string>[]);
      }
      const ok = expected.size === answer.missing.size && [...expected].every(id => answer.missing.has(id));
      scoredKeys.set(key, ok); scored.push({ key, ok, expected, actual: answer.missing });
    }
    categoryScores = scored;
    const scores = new Map(scored.map(row => [row.key, row]));
    const digest = (copy: Pending) => uploaded.get(copy.key)?.slice(0, 12) ?? '未上传';
    const details = (copy: Pending): string => {
      if (unknown.has(copy.key)) return `${digest(copy)} ${unknown.get(copy.key)}`;
      const row = scores.get(copy.key);
      if (!row) return `${digest(copy)} 缺少可核对结果或单用例对照；下一步核对对应运行回执`;
      const extra = [...row.actual].filter(id => !row.expected.has(id)).sort(); const absent = [...row.expected].filter(id => !row.actual.has(id)).sort();
      return `${digest(copy)} 多出 ${extra.join('、') || '无'}；少掉 ${absent.join('、') || '无'}`;
    };
    const checks: Check[] = [];
    for (const [document] of trees.entries()) {
      const own = [...attempted.values()].filter(copy => ownerOf(copy.key) === document);
      const put = (name: string, copies: Pending[], test: (copy: Pending) => boolean, expected: string, describe = details) => {
        const label = `第 ${document + 1} 份 ${name}`;
        if (!copies.length) { notDoneChecks.add(label); return; }
        const bad = copies.filter(copy => !test(copy));
        checks.push(verdict(label, !bad.length, expected, bad.length ? bad.map(describe).join('；') : `核对 ${copies.length} 份，相符 ${copies.length}`));
      };
      const ofKind = (kind: string) => own.filter(copy => copy.kind === kind);
      put('上传字节', own, copy => uploadVerdicts.get(copy.key) === true, '上传引用等于写下字节的摘要', copy => `${digest(copy)} ${unknown.get(copy.key) ?? '上传摘要未核实；下一步重读上传应答并核对写入字节的摘要'}`);
      put('原件用例数', ofKind('a'), copy => !unknown.has(copy.key) && answerOf.get(copy.key)?.caseCount === copy.premise.expected, '用例数等于独立计数', copy => unknown.has(copy.key) ? `${digest(copy)} ${unknown.get(copy.key)}` : `${digest(copy)} 用例 ${answerOf.get(copy.key)?.caseCount ?? '缺结果'}/${copy.premise.expected}`);
      put('单用例副本用例数', ofKind('c'), copy => !unknown.has(copy.key) && answerOf.get(copy.key)?.caseCount === copy.premise.expected, '用例数等于该副本独立计数', copy => unknown.has(copy.key) ? `${digest(copy)} ${unknown.get(copy.key)}` : `${digest(copy)} 用例 ${answerOf.get(copy.key)?.caseCount ?? '缺结果'}/${copy.premise.expected}`);
      put('换序', ofKind('b'), copy => scores.get(copy.key)?.ok === true && answerOf.get(copy.key)?.fullSummary === answerOf.get(`a-${document}`)?.fullSummary, 'b 与 a 缺失集合和摘要逐字相同', copy => `${details(copy)}；${answerOf.get(copy.key)?.fullSummary === answerOf.get(`a-${document}`)?.fullSummary ? '摘要相同' : '摘要不同'}`);
      put('拆分', ofKind('a'), copy => scores.get(copy.key)?.ok === true, 'a 的缺失集合等于全部 c 的交集');
      const typed = ofKind('c').filter(copy => requiredTypes(document, copy.contains[0]!.caseId).size > 0);
      put('类型名标签', typed, copy => {
        const answer = answerOf.get(copy.key); return !!answer && !unknown.has(copy.key) && [...requiredTypes(document, copy.contains[0]!.caseId)].every(id => !answer.missing.has(id));
      }, '类型名标签对应类别必须为有');
      for (const [kind, name] of [['d','删去'],['e','加回'],['f','加入']] as const) put(name, ofKind(kind), copy => scores.get(copy.key)?.ok === true && (kind === 'd' ? answerOf.get(copy.key)!.missing.has(copy.category!) : !answerOf.get(copy.key)!.missing.has(copy.category!)), '全缺失集合相同，且目标类别按变换改变');
    }
    if (fatal) checks.push(verdict('摘要读取格式', false, '截断摘要提供可识别的全文引用', `${uploaded.get(fatal.key)?.slice(0, 12)}；${halted()}`));
    const missing = [...attempted.keys()].filter(key => !answerOf.has(key) || unknown.has(key));
    checks.push(verdict('副本回答完整', attempted.size > 0 && !missing.length, '每份副本给出完整条目结果', missing.length ? missing.map(key => `${uploaded.get(key)?.slice(0, 12)} ${unknown.get(key) ?? '缺结果；下一步重读对应运行的完整条目摘要并核对解析'}`).join('；') : '完整'));
    const completed = trees.filter((_tree, document) => [['a','b'],['c'],['d','e','f']].every(kinds => scored.some(row => ownerOf(row.key) === document && kinds.includes(attempted.get(row.key)!.kind)))).length;
    checks.push(verdict('至少两份文档走完三段', completed >= 2, '至少 2 份', `${completed} 份；上传 ${uploadsOfPhase.join('、')}；运行 ${runsOfPhase.join('、')}`));
    const targetGroups = new Set(scored.filter(row => ['d','f'].includes(attempted.get(row.key)!.kind)).map(row => categories.find(category => category.id === attempted.get(row.key)!.category)?.group));
    checks.push(verdict('类型标签类别和关键词类别各至少一类当过目标', targetGroups.has('test_type') && [...targetGroups].some(group => group !== undefined && group !== 'test_type'), '两类均有实际核对目标', `${targetGroups.size} 类`));
    checks.push(verdict('对话没有被压缩', !compacted, '没有压缩请求', compacted ? '收到过' : '没有'));
    checkFindings = [...new Map(findings.map(finding => [finding.runKey, finding])).values()];
    return checks;
  };

  // The sections are computed lazily (accept-circle.ts reads them after check()); the counts come from the scored
  // copies check() left behind.
  const reasonCounts = (): Map<string, number> => {
    const reasons = new Map<string, number>();
    for (const [key, reason] of unknown) {
      const weight = key.startsWith('phase2-') ? outerIds[Number(key.split('-')[1])]?.length ?? 1 : 1;
      reasons.set(reason, (reasons.get(reason) ?? 0) + weight);
    }
    for (const finding of checkFindings) if (!unknown.has(finding.runKey)) reasons.set('单用例副本结果不可核对；下一步重读并核对该单用例结果，修复计数差异后重跑依赖段', (reasons.get('单用例副本结果不可核对；下一步重读并核对该单用例结果，修复计数差异后重跑依赖段') ?? 0) + 1);
    return reasons;
  };
  const phaseLines = () => uploadsOfPhase.map((uploads, phase) => `第 ${phase + 1} 段：上传 ${uploads}，运行 ${runsOfPhase[phase]}`);
  const sectionsOf = (): ReportSection[] => {
    const kindOf = (key: string): string => key.replace(/^([a-z])-.*/, '$1');
    const lines: string[] = [];
    for (const category of categories) {
      const targeted = categoryScores.filter(row => attempted.get(row.key)?.category === category.id).length;
      const parts = (['a', 'b', 'c', 'd', 'e', 'f'] as const).map((kind) => {
        const own = categoryScores.filter(row => kindOf(row.key) === kind);
        const ok = own.filter(row => row.expected.has(category.id) === row.actual.has(category.id)).length;
        return `${kind} 相符 ${ok} 不符 ${own.length - ok}`;
      });
      lines.push(`${category.id}（${category.group === 'test_type' ? '类型标签' : '关键词'}）：${parts.join('；')}；当目标 ${targeted} 次`);
    }
    const sections: ReportSection[] = [{ title: '分段计数', lines: phaseLines() }, { title: '按类别的计数', lines }];
    const reasons = reasonCounts();
    const skipped: string[] = [];
    for (const [d, tree] of trees.entries()) {
      const plan = planCopies(tree, `doc${d + 1}`, { categories, singleMisses: singleMissesOf(d), ...(trees.length > 1 ? { other: { tree: trees[(d + 1) % trees.length]!, singleMisses: singleMissesOf((d + 1) % trees.length) } } : {}) });
      for (const entry of [...plan.d, ...plan.f]) {
        if ('skipped' in entry) skipped.push(`第 ${d + 1} 份文档 ${entry.category}：${entry.skipped.reason}——${entry.skipped.detail}；${skipActions[entry.skipped.reason]}`);
      }
    }
    const findingLines = checkFindings.map(f => `第 ${f.document + 1} 份文档，用例 ${outerIds[f.document]!.indexOf(f.caseId) + 1}，副本 ${uploaded.get(f.runKey)?.slice(0, 12) ?? '未上传'} 结果不可核对：${f.why}；依赖副本没有核对；下一步重读并核对该副本，修复差异后重跑依赖段`);
    sections.push({ title: '没做的副本（按原因）', lines: [...[...notDoneChecks].map(name => `${name}：没有可核对的副本；下一步补齐依赖答案或换用满足前提的文档后重跑`), ...[...reasons.entries()].map(([r, n]) => `${r}：${n} 份`), ...skipped, ...findingLines] });
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
    get countLines(): string[] {
      return [...phaseLines(), ...sectionsOf().find(section => section.title === '按类别的计数')!.lines, ...[...reasonCounts()].map(([reason, count]) => `没做：${reason}：${count} 份`)];
    },
    get sections(): ReportSection[] {
      return sectionsOf();
    },
    prepare(dir: string): void {
      mkdirSync(dir, { recursive: true });
      workdir = dir;
    },
  };
}
