// Reproducible human existence spot checks of the location output. No network or database access.
// sample --results <location-tree out> [--count 10] [--seed <seed>] --record <new private JSON>
// tally --record <private JSON manually completed with found: true or false>
// Unclassified numbers remain unclassified: the record asks the person to look in both namespaces.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privatePath, writePrivateJson } from '../gold/builds.ts';
import { unreadResults, unreadResultAction, unreadResultRecovery, collectionRecoveryAction, type Pending, capturedResult, readCaptures, resultItems, refusedDocuments, uncertainStarts } from './location-tree.ts';

export interface SampleId {
  id: string;
  kind: 'story' | 'bug' | null;
  external: string | null;
  documents: string[];
}
type MissingFact = Pick<Pending,'document'|'fact'|'next_action'|'recovery'>;
interface Entry extends SampleId { found: boolean | null; lookup?: string[] }
interface SampleRecord {
  schema: 'id-spot-check@1'; seed: string; results_sha256: string;
  totals: { stories: number; bugs: number; unclassified: number };
  requested: number; population_complete: boolean; entries: Entry[]; not_run: MissingFact[]; excluded: Array<{ document: string; reason: string }>;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const keyOf = (item: SampleId): string => item.external ?? `unclassified:${item.id}`;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Hash order depends on the seed and numeric identifier; namespace is a deterministic tie-break only. */
export function sampleIds(items: readonly SampleId[], count: number, seed: string): SampleId[] {
  const seen = new Map(items.map(item => [keyOf(item), item]));
  return [...seen.values()].map(item => ({ item, order: digest(seed + item.id) }))
    .sort((a, b) => compare(a.order, b.order) || compare(keyOf(a.item), keyOf(b.item)))
    .slice(0, count).map(row => row.item);
}

export async function main(argv: string[], print: (line: string) => void = line => process.stdout.write(line + '\n')): Promise<number> {
  const [mode, ...args] = argv;
  const values = new Map<string, string>();
  let stage = '参数与 --record 输入', action = '给出 sample/tally、仓库外输入和新记录文件后重跑';
  try {
    for (let at = 0; at < args.length; at += 2) {
      const key = args[at], value = args[at + 1];
      if (!['--results', '--count', '--seed', '--record'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('参数无效');
      values.set(key, value);
    }
    const recordFile = values.get('--record'); if (!recordFile) throw new Error('缺记录文件');
    privatePath(recordFile);
    if (mode === 'sample') {
      const resultDir = values.get('--results'); if (!resultDir) throw new Error('缺结果输入');
      const count = Number(values.get('--count') ?? 10), seed = values.get('--seed') ?? randomBytes(16).toString('hex');
      if (!Number.isSafeInteger(count) || count < 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(seed)) throw new Error('计数或种子无效');
      stage = '--results/runs 完整结果输入'; action = '重读完整 get_nodes 结果到仓库外 runs，再以相同种子和新 --record 重跑';
      const saved = readCaptures(privatePath(resultDir));
      const items = new Map<string, SampleId>(), missing: MissingFact[] = [];
      const excluded: Array<{ document: string; reason: string }> = [];
      const accepted = new Set<string>(), refused = refusedDocuments(saved.captures, true), uncertain = uncertainStarts(saved.captures), unread = unreadResults(saved.captures);
      const results = new Set<string>(), observed = new Set<string>(), requested = new Set<string>();
      for (const capture of saved.captures) {
        const args = capture.request.args;
        if (capture.request.tool !== 'start_run' || !object(args) || !object(args.inputs)) continue;
        const inputs = Array.isArray(args.inputs.documents) ? args.inputs.documents : [args.inputs.documents];
        for (const input of inputs) if (object(input) && typeof input.external === 'string' && input.external.startsWith('agile:mindmap:')) { const document = input.external.slice('agile:mindmap:'.length); requested.add(document); if (!capture.response.isError && object(capture.response.structured) && capture.response.structured.call_result === 'ok') accepted.add(document); }
      }
      for (const capture of saved.captures) {
        const result = capturedResult(capture); if (result === null) continue;
        const resultHash = digest(JSON.stringify(result)); if (results.has(resultHash)) continue; results.add(resultHash);
        for (const item of resultItems(result)) {
          observed.add(item.document);
          if (!item.location) { missing.push({ document: item.document, fact: '本份文档的 location 数据', next_action: '重读完整结果的 location 主张；仍缺则单独重跑本份文档，再重新抽样' }); continue; }
          for (const [field, kind] of [['requirements', 'story'], ['defects', 'bug'], ['unclassified', null]] as const) {
            const ids = item.location[field];
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[0-9]+$/.test(id))) {
              missing.push({ document: item.document, fact: `location.${field} 的完整编号数组`, next_action: '重读本份完整 location 数据；仍缺则重跑定位，再用同一种子重新抽样' }); continue;
            }
            for (const id of ids as string[]) {
              const external = kind === null ? null : `plm:${kind}:${id}`;
              const itemKey = external ?? `unclassified:${id}`;
              const known = items.get(itemKey) ?? { id, kind, external, documents: [] };
              if (!known.documents.includes(item.document)) known.documents.push(item.document);
              items.set(itemKey, known);
            }
          }
        }
      }
      for (const document of requested) if (!observed.has(document) && !accepted.has(document) && refused.has(document) && !uncertain.has(document)) excluded.push({ document, reason: refused.get(document)! });
      for (const document of requested) if (!observed.has(document) && !excluded.some(row => row.document === document)) {
        const start = uncertain.get(document), result = unread.get(document);
        missing.push({document, fact:result?.reference===null?'运行已受理但没有结果引用':'已请求但未取得的完整 location 结果', next_action: start ? collectionRecoveryAction() : result ? unreadResultAction(result) : '单独重跑本份文档的 case-location，再读取完整 get_nodes 结果后重新抽样；不能从残缺总体抽样',
          ...(start ? {recovery:{tool:'start_run',args:start.args,session:start.session}} : result ? {recovery:unreadResultRecovery(result)} : {})});
      }
      for (const item of items.values()) item.documents.sort(compare);
      if (results.size === 0) missing.push({ document: '（结果输入没有可用文档）', fact: '完整定位结果', next_action: '先完成记录里逐份文档的恢复动作，确认 get_nodes 的结构化 content.text 是完整 JSON 后从新 --out 重新抽样；无结果引用时先请集成者修复 Hub 持久化缺口，不直接新建 key 重跑' });
      const totals = { stories: [...items.values()].filter(i => i.kind === 'story').length, bugs: [...items.values()].filter(i => i.kind === 'bug').length, unclassified: [...items.values()].filter(i => i.kind === null).length };
      const entries: Entry[] = missing.length ? [] : sampleIds([...items.values()], count, seed).map(item => ({ ...item, found: null, ...(item.kind === null ? { lookup: [`plm:story:${item.id}`, `plm:bug:${item.id}`] } : {}) }));
      const record: SampleRecord = { schema: 'id-spot-check@1', seed, results_sha256: saved.sha256, totals, requested: count, population_complete: missing.length === 0, entries, excluded, not_run: missing };
      stage = '--record 新输出文件（不可覆盖）'; action = '保留旧记录，另选仓库外新记录文件后重跑 sample';
      const bytes = writePrivateJson(recordFile, record);
      print(`${missing.length ? '已见计数（输入不完整）' : '总体'}：需求 ${totals.stories} 个，缺陷 ${totals.bugs} 个，未分类 ${totals.unclassified} 个；抽了 ${entries.length} 个；没跑 ${missing.length} 项；开始被拒排除 ${excluded.length} 份`);
      print(`种子 ${seed}`); print(`记录 sha256 ${digest(bytes)}`);
      if (missing.length) print('下一步：按记录里的具体文档和字段重读或重跑，再以相同种子重新抽样；没跑不计通过或不通过');
      else print('下一步：按记录逐个到缺陷系统查询，未分类编号查需求和缺陷两处，只填写 found=true 或 false，再运行 tally');
      return missing.length ? 2 : 0;
    }
    if (mode === 'tally') {
      stage = '--record 人工抽查记录输入'; action = '检查仓库外记录；逐个查询未填编号后把 found 填为 true/false，再运行 tally';
      const bytes = readFileSync(privatePath(recordFile)), value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(value) || value.schema !== 'id-spot-check@1' || !Array.isArray(value.entries) || !Array.isArray(value.not_run)) throw new Error('记录无效');
      const entries = value.entries;
      if (!value.not_run.every(row => object(row) && typeof row.document === 'string' && typeof row.fact === 'string' && typeof row.next_action === 'string')) throw new Error('缺少事实的记录无效');
      if (!entries.every(row => object(row) && typeof row.id === 'string' && /^[0-9]+$/.test(row.id) && (row.kind === 'story' || row.kind === 'bug' || row.kind === null) && row.external === (row.kind === null ? null : `plm:${row.kind}:${row.id}`) && (row.found === null || row.found === true || row.found === false))) throw new Error('found 必须为布尔值或 null');
      if (new Set(entries.map(row => row.external ?? 'unclassified:' + row.id)).size !== entries.length) throw new Error('样本身份重复');
      const found = entries.filter(row => row.found === true).length, absent = entries.filter(row => row.found === false).length, blank = entries.filter(row => row.found === null).length;
      print(`找到 ${found} 个，没找到 ${absent} 个，没填 ${blank} 个；没跑 ${value.not_run.length} 项`);
      print(`记录 sha256 ${digest(bytes)}`);
      if (!entries.length && !value.not_run.length) print('没跑：本批没有待抽查编号；下一步：询问集成者确认抽查范围；若选错结果，改用含编号的完整定位结果后重新抽样，不能补造编号');
      else if (blank || value.not_run.length) print('下一步：补取记录列出的缺少事实；逐个查询未填编号后填写 found，再运行 tally；没跑不计通过或不通过');
      return absent ? 1 : blank || value.not_run.length || !entries.length ? 2 : 0;
    }
    throw new Error('模式无效');
  } catch {
    print(`没跑：${stage} 不可用；下一步：${action}`);
    return 2;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
