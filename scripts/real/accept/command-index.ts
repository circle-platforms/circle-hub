// Independent comparison of raw-map gold with exported index views. No Hub or pack imports.
import { readFileSync, writeFileSync } from 'node:fs';
import { comparableNode, documentKey, sha256, type CommandsGold } from '../gold/case-commands.ts';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const difference = (a: Iterable<string>, b: ReadonlySet<string>) => sorted(a).filter((k) => !b.has(k));
export interface IndexReport {
  verdict: '相等' | '不相等' | '输入不全';
  counts: Record<string, number>;
  hashes: { gold: string; hub: string };
  details: Record<string, unknown>;
  incomplete: string[];
}
export function compareCommandIndex(gold: CommandsGold, views: readonly unknown[]): IndexReport {
  if (gold.schema !== 'case-commands-gold@1' || !Array.isArray(gold.cases) || !Array.isArray(gold.documents)) throw new Error('金标准格式不对');
  const incomplete: string[] = [];
  const hub = new Map<string, Set<string>>();
  const hubDocs = new Set<string>();
  const ignored = new Set<string>();
  const dataMismatches = new Set<string>();
  const excludedGold = new Set(gold.cases.filter((c) => !c.comparable).map((c) => c.key));
  const allHub = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  const requested = new Set<string>();
  let full = false;
  let root: string | undefined;
  let product: string | undefined;
  for (const raw of views) {
    if (!record(raw) || raw.schema !== 'index-view@1' || raw.kind !== 'case' || raw.key !== 'document' || !record(raw.build) || typeof raw.build.root !== 'string' || !/^[a-f0-9]{64}$/.test(raw.build.root) || !record(raw.entries) || !record(raw.keys) || typeof raw.truncated !== 'boolean') { incomplete.push('索引视图格式不对'); continue; }
    if (root !== undefined && (root !== raw.build.root || product !== raw.product)) incomplete.push('索引根或产品不同');
    root = raw.build.root; product = String(raw.product);
    if (raw.truncated || (Array.isArray(raw.cut_keys) && raw.cut_keys.length)) incomplete.push('索引分片仍被截断：重新按 only= 分成更小的导出');
    if (typeof raw.skipped === 'number' && raw.skipped > 0) incomplete.push('索引有未读来源：修复来源后重新导出');
    if (Array.isArray(raw.only)) for (const key of raw.only) requested.add(documentKey(String(key)));
    else full = true;
    const listed = new Set<string>();
    for (const [doc, digests] of Object.entries(raw.keys)) {
      hubDocs.add(documentKey(doc));
      if (!Array.isArray(digests)) { incomplete.push('索引键的条目表无效'); continue; }
      for (const digest of digests) {
        if (typeof digest !== 'string' || !Object.hasOwn(raw.entries, digest)) incomplete.push('索引键指向缺失条目');
        else listed.add(digest);
      }
    }
    for (const [digest, entry] of Object.entries(raw.entries)) {
      if (!listed.has(digest) || !record(entry) || entry.kind !== 'case' || !record(entry.data) || typeof entry.data.document !== 'string' || typeof entry.data.node !== 'string' || !Array.isArray(entry.data.commands) || entry.data.commands.some((v) => typeof v !== 'string') || typeof entry.reference !== 'string') { incomplete.push('索引条目缺少必要事实'); continue; }
      const match = /^tree:([a-f0-9]{64})(\/[^@]*)@([a-f0-9]{64})$/.exec(entry.reference);
      if (!match || match[1] !== root || match[3] !== digest || entry.entry !== digest) { incomplete.push('条目引用与索引根或摘要不符'); continue; }
      const doc = documentKey(entry.data.document); const node = entry.data.node; const key = `${doc}:${node}`;
      if (!Array.isArray(raw.keys[entry.data.document]) || !(raw.keys[entry.data.document] as unknown[]).includes(digest)) { incomplete.push('条目文档与索引键不符'); continue; }
      hubDocs.add(doc);
      const allPaths = allHub.get(key) ?? new Set<string>();
      if (match[2] !== '/') allPaths.add(match[2]);
      allHub.set(key, allPaths);
      if (!comparableNode(node) || excludedGold.has(key)) { ignored.add(key); continue; }
      const paths = hub.get(key) ?? new Set<string>();
      if (match[2] !== '/') paths.add(match[2]);
      hub.set(key, paths);
      const commands = new Set(entry.data.commands as string[]);
      const old = declared.get(key);
      if (old && JSON.stringify(sorted(old)) !== JSON.stringify(sorted(commands))) dataMismatches.add(key);
      declared.set(key, commands);
    }
  }
  if (!views.length) incomplete.push('没有索引视图');
  if (!full && gold.documents.some((doc) => !requested.has(documentKey(doc)))) incomplete.push('分片没有请求全部金标准文档：补导出缺少的 only= 文档');
  for (const [key, paths] of hub) if (JSON.stringify(sorted(paths)) !== JSON.stringify(sorted(declared.get(key) ?? []))) dataMismatches.add(key);
  const goldMap = new Map(gold.cases.filter((c) => c.comparable).map((c) => [c.key, new Set(c.paths.map((p) => p.path))]));
  const goldKeys = new Set(goldMap.keys()); const hubKeys = new Set(hub.keys());
  const shared = sorted(goldKeys).filter((key) => hub.has(key));
  const onlyGold = difference(goldKeys, hubKeys); const onlyHub = difference(hubKeys, goldKeys);
  const pathDiffs = sorted([...goldKeys, ...hubKeys]).map((key) => ({ key, gold: difference(goldMap.get(key) ?? [], hub.get(key) ?? new Set()), hub: difference(hub.get(key) ?? [], goldMap.get(key) ?? new Set()) }));
  const different = pathDiffs.filter((row) => row.gold.length || row.hub.length);
  const goldUnplaced = new Set([...goldMap].filter(([, paths]) => !paths.size).map(([key]) => key));
  const hubUnplaced = new Set([...hub].filter(([, paths]) => !paths.size).map(([key]) => key));
  const onlyGoldPaths = different.flatMap((row) => row.gold.map((path) => ({ key: row.key, path })));
  const goldCases = new Map(gold.cases.filter((c) => c.comparable).map((c) => [c.key, c]));
  const table = (map: Map<string, Set<string>>) => sorted(map.keys()).map((key) => [key, sorted(map.get(key)!)]);
  const counts = {
    documents_both: [...new Set(gold.documents)].filter((doc) => hubDocs.has(doc)).length,
    documents_gold_only: difference(gold.documents, hubDocs).length, documents_hub_only: difference(hubDocs, new Set(gold.documents)).length,
    cases_both: shared.length, cases_gold_only: onlyGold.length, cases_hub_only: onlyHub.length,
    excluded_gold: gold.cases.filter((c) => !c.comparable).length, excluded_hub: ignored.size,
    commands_equal: shared.length - different.filter((row) => goldKeys.has(row.key) && hubKeys.has(row.key)).length, commands_different: different.filter((row) => goldKeys.has(row.key) && hubKeys.has(row.key)).length,
    paths_gold_only: onlyGoldPaths.length, paths_hub_only: different.reduce((n, row) => n + row.hub.length, 0),
    paths_gold_abbreviated: onlyGoldPaths.filter(({ key, path }) => goldCases.get(key)!.paths.find((p) => p.path === path)!.abbreviated).length,
    paths_gold_via_no: onlyGoldPaths.filter(({ key, path }) => goldCases.get(key)!.paths.find((p) => p.path === path)!.via_no).length,
    paths_gold_single_word: onlyGoldPaths.filter(({ key, path }) => goldCases.get(key)!.paths.find((p) => p.path === path)!.words === 1).length,
    unplaced_gold: gold.cases.filter((c) => !c.paths.length).length, unplaced_hub: [...allHub.values()].filter((paths) => !paths.size).length,
    unplaced_gold_comparable: goldUnplaced.size, unplaced_hub_comparable: hubUnplaced.size,
    unplaced_both: [...goldUnplaced].filter((key) => hubUnplaced.has(key)).length,
    unplaced_gold_only: difference(goldUnplaced, hubUnplaced).length, unplaced_hub_only: difference(hubUnplaced, goldUnplaced).length,
    steps_placed_in_hub_unplaced: [...hubUnplaced].filter((key) => (goldCases.get(key)?.steps.length ?? 0) > 0).length,
    entry_data_mismatches: dataMismatches.size,
  };
  const equal = !onlyGold.length && !onlyHub.length && !different.length && !dataMismatches.size && !counts.documents_gold_only && !counts.documents_hub_only;
  return { verdict: incomplete.length ? '输入不全' : equal ? '相等' : '不相等', counts, hashes: { gold: sha256(JSON.stringify(table(goldMap))), hub: sha256(JSON.stringify(table(hub))) },
    details: { documents_gold_only: difference(gold.documents, hubDocs), documents_hub_only: difference(hubDocs, new Set(gold.documents)), cases_gold_only: onlyGold, cases_hub_only: onlyHub, paths: different, entry_data_mismatches: sorted(dataMismatches) }, incomplete: sorted(incomplete) };
}
export function renderIndexReport(report: IndexReport): string {
  const labels: Record<string, string> = {
    documents_both: '两边共有文档', documents_gold_only: '只在 gold 的文档', documents_hub_only: '只在 Hub 的文档',
    cases_both: '两边共有用例', cases_gold_only: '只在 gold 的用例', cases_hub_only: '只在 Hub 的用例', excluded_gold: 'gold 不比较用例', excluded_hub: 'Hub 不比较用例',
    commands_equal: '命令集合相等用例', commands_different: '命令集合不等用例', paths_gold_only: '只在 gold 的路径', paths_hub_only: '只在 Hub 的路径', paths_gold_abbreviated: '只在 gold 的路径中经缩写识别', paths_gold_via_no: '只在 gold 的路径中经 no 识别', paths_gold_single_word: '只在 gold 的路径中单词命令',
    unplaced_gold: 'gold 全部未归位用例', unplaced_hub: 'Hub 全部未归位用例', unplaced_gold_comparable: 'gold 可比较未归位用例', unplaced_hub_comparable: 'Hub 可比较未归位用例',
    unplaced_both: '可比较用例中两边都未归位', unplaced_gold_only: '可比较用例中只有 gold 未归位', unplaced_hub_only: '可比较用例中只有 Hub 未归位', steps_placed_in_hub_unplaced: 'Hub 可比较未归位用例中步骤有命令', entry_data_mismatches: '条目与数据命令集合不符用例',
  };
  return [...Object.entries(report.counts).map(([name, count]) => `${labels[name]}：${count}`), `gold SHA-256：${report.hashes.gold}`, `Hub SHA-256：${report.hashes.hub}`, `输入缺项：${report.incomplete.length}`, `判定：${report.verdict}`].join('\n');
}
export function main(argv: string[]): number {
  try {
    const value = (name: string) => argv[argv.indexOf(`--${name}`) + 1];
    const indices = argv.flatMap((arg, i) => arg === '--index' ? [argv[i + 1]] : []);
    if (!argv.includes('--gold') || !indices.length) throw new Error('缺少输入');
    const report = compareCommandIndex(JSON.parse(readFileSync(value('gold'), 'utf8')) as CommandsGold, indices.map((file) => JSON.parse(readFileSync(file, 'utf8')) as unknown));
    if (argv.includes('--out')) writeFileSync(value('out'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${renderIndexReport(report)}\n`);
    return report.verdict === '相等' ? 0 : 1;
  } catch { process.stderr.write('读取或比较失败：检查 gold 和全部索引分片的格式及可读性\n'); return 1; }
}
if (process.argv[1]?.endsWith('/accept/command-index.ts')) process.exitCode = main(process.argv.slice(2));
