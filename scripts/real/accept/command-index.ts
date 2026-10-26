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
  incompleteSummary: IncompleteCategory[];
}
export class IndexInputError extends Error {readonly reason:'wrong_view'|'malformed_view'|'gold'|'read'|'json'|'write';constructor(reason:'wrong_view'|'malformed_view'|'gold'|'read'|'json'|'write',message:string){super(message);this.name='IndexInputError';this.reason=reason;}}
function indexView(raw:unknown):Record<string,any>{if(!record(raw)||raw.schema!=='index-view@1'||raw.kind!=='case'||raw.key!=='document')throw new IndexInputError('wrong_view','需要第 2 步的 kind=case、key=document 索引导出');if(!record(raw.build)||typeof raw.build.root!=='string'||!/^[a-f0-9]{64}$/.test(raw.build.root)||!record(raw.entries)||!record(raw.keys)||typeof raw.truncated!=='boolean')throw new IndexInputError('malformed_view','索引视图格式不对');if(typeof raw.product!=='string'||!raw.product||typeof raw.build.build!=='string'||!raw.build.build||![raw.total_keys,raw.total_entries,raw.skipped].every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)||!Array.isArray(raw.notes)||raw.notes.some(v=>typeof v!=='string')||raw.only!==undefined&&(!Array.isArray(raw.only)||raw.only.some(v=>typeof v!=='string')))throw new IndexInputError('malformed_view','索引视图缺少合式的产品、构建、总数、说明或分片范围字段');return raw;}
export function compareCommandIndex(gold: CommandsGold, views: readonly unknown[]): IndexReport {
  if (!gold || gold.schema !== 'case-commands-gold@1' || !Array.isArray(gold.cases) || !Array.isArray(gold.documents)) throw new IndexInputError('gold','金标准格式不对');
  const incomplete: string[] = [];const reasons:IncompleteCategory[]=[];let rejectedViews=0;
  const gap=(category:string,missing:string,action:string,message:string,count=1)=>{incomplete.push(message);reasons.push({category,count,missing,action});};
  const caseCounts = new Map(gold.documents.map((doc) => [doc, gold.document_cases?.[doc] ?? gold.cases.filter((c) => c.document === doc).length]));
  const expectedDocuments = gold.documents.filter((doc) => (caseCounts.get(doc) ?? 0) > 0);
  const zeroDocuments = gold.documents.filter((doc) => caseCounts.get(doc) === 0);
  const hubDefects: string[] = [];
  const hub = new Map<string, Set<string>>();
  const hubDocs = new Set<string>();
  const ignored = new Set<string>();
  const dataMismatches = new Set<string>();
  const excludedGold = new Set(gold.cases.filter((c) => !c.comparable).map((c) => c.key));
  const allHub = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  const requested = new Set<string>();
  const cutDocuments = new Set<string>();
  let full = false;
  let root: string | undefined;
  let secondarySnapshot: string | undefined;
  let product: string | undefined;
  for (const value of views) {
    const identity=record(value)&&value.schema==='index-view@1'&&value.kind==='case'&&value.key==='document';
    if(identity){if(Array.isArray(value.only))for(const key of value.only)requested.add(documentKey(String(key)));else full=true;}
    let raw:Record<string,any>;try{raw=indexView(value);}catch(error){if(!(error instanceof IndexInputError))throw error;rejectedViews++;if(error.reason==='wrong_view')gap('视图类型不符','第 2 步的文档用例索引','用第 2 步指定的 key=document、kind=case 引用重新导出',error.message);else hubDefects.push(error.message);continue;}
    const secondary=raw.unversioned===undefined||raw.unversioned===null?null:raw.unversioned;
    if(secondary!==null&&(!record(secondary)||typeof secondary.root!=='string'||!/^[a-f0-9]{64}$/.test(secondary.root)||typeof secondary.composition!=='string'||!/^[a-f0-9]{64}$/.test(secondary.composition)||secondary.build!==null)){hubDefects.push('不分版本根的来源声明不合格');continue;}
    const snapshot=JSON.stringify(secondary===null?null:{root:secondary.root,composition:secondary.composition});
    if (root !== undefined && (root !== raw.build.root || product !== raw.product || secondarySnapshot!==snapshot)) gap('根不一致','同一产品和根的分片','重新导出同一产品和构建根的全部分片','索引根或产品不同');
    root = raw.build.root; product = String(raw.product);secondarySnapshot=snapshot;
    const cut = Array.isArray(raw.cut_keys) ? raw.cut_keys : [];
    for (const key of cut) if (typeof key === 'string') cutDocuments.add(key); else hubDefects.push('cut_keys 含有不是文档键的值');
    if (raw.cut_keys !== undefined && !Array.isArray(raw.cut_keys)) hubDefects.push('cut_keys 不是数组');
    const notes=Array.isArray(raw.notes)?raw.notes.filter((v:unknown):v is string=>typeof v==='string'):[];
    // These are explicit declarations in the source view, never inferred exception messages.
    const excluded=notes.some((note:string)=>note.includes('个条目的文字有凭据扫描命中，没有放进这个视图')||note.startsWith('取值 __proto__ 不能作为这个视图的键'));
    const budgetNote=notes.some((note:string)=>note.startsWith('取值按顺序列到 '));
    const missingKeys=Number.isSafeInteger(raw.total_keys)&&Object.keys(raw.keys).length<raw.total_keys;
    const missingEntries=Number.isSafeInteger(raw.total_entries)&&Object.keys(raw.entries).length<raw.total_entries;
    const budget=missingKeys&&(!excluded||budgetNote);
    if(raw.truncated&&budget)gap('分片截断','完整索引键及条目','按 only= 分成更小分片后重新导出','索引键没有完整列出：存在预算停止');
    if(raw.truncated&&(excluded||!budget&&!cut.length&&(missingEntries||!missingKeys)))gap('来源排除','被排除或保留键下的条目及说明','核对 notes 的凭据、保留键说明及引用，用 get_nodes 读取被引条目；无可用引用则交集成者处理，不能靠 only= 恢复','索引条目未完整列出：来源排除或视图未给出完整截断原因');
    if (!Number.isSafeInteger(raw.skipped) || (raw.skipped as number) < 0) hubDefects.push('索引缺少合式的 skipped 元数据');
    else if (raw.skipped !== 0) gap('未读来源','来源完整性','修复来源并重新生产根，再导出索引','索引有未读来源：修复来源后重新导出');
    if (Array.isArray(raw.only)) for (const key of raw.only) requested.add(documentKey(String(key)));
    else full = true;
    const listed = new Set<string>();
    for (const [doc, digests] of Object.entries(raw.keys)) {
      hubDocs.add(documentKey(doc));
      if (!Array.isArray(digests)) { hubDefects.push('索引键的条目表无效'); continue; }
      for (const digest of digests) {
        if (typeof digest !== 'string' || !Object.hasOwn(raw.entries, digest)) hubDefects.push('索引键指向缺失条目');
        else listed.add(digest);
      }
    }
    for (const [digest, entry] of Object.entries(raw.entries)) {
      if (!listed.has(digest) || !record(entry) || entry.kind !== 'case' || !record(entry.data) || typeof entry.data.document !== 'string' || typeof entry.data.node !== 'string' || !Array.isArray(entry.data.commands) || entry.data.commands.some((v) => typeof v !== 'string') || typeof entry.reference !== 'string') { hubDefects.push('索引条目缺少必要事实'); continue; }
      const match = /^tree:([a-f0-9]{64})(\/[^@]*)@([a-f0-9]{64})$/.exec(entry.reference);
      const scopeEntry=entry.build===null;
      if (!match || (scopeEntry ? secondary===null||match[1]!==secondary.root||entry.root!==secondary.root : match[1]!==root||entry.root!==undefined&&entry.root!==root||entry.build!==undefined) || match[3] !== digest || entry.entry !== digest) { hubDefects.push('条目引用与索引根或摘要不符'); continue; }
      const doc = documentKey(entry.data.document); const node = entry.data.node; const key = `${doc}:${node}`;
      if (!Array.isArray(raw.keys[entry.data.document]) || !(raw.keys[entry.data.document] as unknown[]).includes(digest)) { hubDefects.push('条目文档与索引键不符'); continue; }
      hubDocs.add(doc);
      const allPaths = allHub.get(key) ?? new Set<string>();
      const commands = new Set(entry.data.commands as string[]);
      for(const path of commands)allPaths.add(path);
      // An index cites the first placement once; it does not enumerate every tree placement.
      if(match[2] !== (sorted(commands)[0]??'/'))dataMismatches.add(key);
      allHub.set(key, allPaths);
      if (!comparableNode(node) || excludedGold.has(key)) { ignored.add(key); continue; }
      const paths = hub.get(key) ?? new Set<string>();
      for(const path of commands)paths.add(path);
      hub.set(key, paths);
      const old = declared.get(key);
      if (old && JSON.stringify(sorted(old)) !== JSON.stringify(sorted(commands))) dataMismatches.add(key);
      declared.set(key, commands);
    }
  }
  if(cutDocuments.size)gap('单键截断','文档键下被截掉的完整条目','交集成者协调提高单键上限后重导；only= 不能拆开同一键',`单键截断 ${cutDocuments.size} 个文档：缺少完整条目`,cutDocuments.size);
  if (!views.length) gap('没有视图','索引导出文件','提供完整索引视图及其分片','没有索引视图');
  if (!full && rejectedViews===0 && expectedDocuments.some((doc) => !requested.has(documentKey(doc)))) gap('缺少分片','金标准文档对应的全部分片','补齐对应 only= 分片再比较','分片没有请求全部金标准文档：补导出缺少的 only= 文档');
  for (const [key, paths] of hub) if (JSON.stringify(sorted(paths)) !== JSON.stringify(sorted(declared.get(key) ?? []))) dataMismatches.add(key);
  const expectedPaths=(c:CommandsGold["cases"][number])=>c.placement_paths??c.paths;
  const goldMap = new Map(gold.cases.filter((c) => c.comparable).map((c) => [c.key, new Set(expectedPaths(c).map((p) => p.path))]));
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
    documents_zero_case: zeroDocuments.length,
    documents_both: [...new Set(expectedDocuments)].filter((doc) => hubDocs.has(doc)).length,
    documents_gold_only: difference(expectedDocuments, hubDocs).length, documents_hub_only: difference(hubDocs, new Set(expectedDocuments)).length,
    cases_both: shared.length, cases_gold_only: onlyGold.length, cases_hub_only: onlyHub.length,
    excluded_gold: gold.cases.filter((c) => !c.comparable).length, excluded_hub: ignored.size,
    commands_equal: shared.length - different.filter((row) => goldKeys.has(row.key) && hubKeys.has(row.key)).length, commands_different: different.filter((row) => goldKeys.has(row.key) && hubKeys.has(row.key)).length,
    paths_gold_only: onlyGoldPaths.length, paths_hub_only: different.reduce((n, row) => n + row.hub.length, 0),
    paths_gold_abbreviated: onlyGoldPaths.filter(({ key, path }) => expectedPaths(goldCases.get(key)!).find((p) => p.path === path)!.abbreviated).length,
    paths_gold_via_no: onlyGoldPaths.filter(({ key, path }) => expectedPaths(goldCases.get(key)!).find((p) => p.path === path)!.via_no).length,
    paths_gold_single_word: onlyGoldPaths.filter(({ key, path }) => expectedPaths(goldCases.get(key)!).find((p) => p.path === path)!.words === 1).length,
    unplaced_gold: gold.cases.filter((c) => !expectedPaths(c).length).length, unplaced_hub: [...allHub.values()].filter((paths) => !paths.size).length,
    unplaced_gold_comparable: goldUnplaced.size, unplaced_hub_comparable: hubUnplaced.size,
    unplaced_both: [...goldUnplaced].filter((key) => hubUnplaced.has(key)).length,
    unplaced_gold_only: difference(goldUnplaced, hubUnplaced).length, unplaced_hub_only: difference(hubUnplaced, goldUnplaced).length,
    steps_placed_in_hub_unplaced: [...hubUnplaced].filter((key) => (goldCases.get(key)?.steps.length ?? 0) > 0).length,
    entry_data_mismatches: dataMismatches.size, hub_entry_defects: hubDefects.length,
  };
  const equal = !hubDefects.length && !onlyGold.length && !onlyHub.length && !different.length && !dataMismatches.size && !counts.documents_gold_only && !counts.documents_hub_only;
  return { verdict: hubDefects.length ? '不相等' : incomplete.length ? '输入不全' : equal ? '相等' : '不相等', counts, hashes: { gold: sha256(JSON.stringify(table(goldMap))), hub: sha256(JSON.stringify(table(hub))) },
    details: { hub_entry_defects: hubDefects, documents_zero_case: zeroDocuments, documents_gold_only: difference(expectedDocuments, hubDocs), documents_hub_only: difference(hubDocs, new Set(expectedDocuments)), cases_gold_only: onlyGold, cases_hub_only: onlyHub, paths: different, entry_data_mismatches: sorted(dataMismatches) }, incomplete: sorted(incomplete), incompleteSummary: mergeIncomplete(reasons) };
}
export function renderIndexReport(report: IndexReport): string {
  const labels: Record<string, string> = {
    documents_zero_case: 'gold 无用例文档', documents_both: '两边共有文档', documents_gold_only: '只在 gold 的文档', documents_hub_only: '只在 Hub 的文档',
    cases_both: '两边共有用例', cases_gold_only: '只在 gold 的用例', cases_hub_only: '只在 Hub 的用例', excluded_gold: 'gold 不比较用例', excluded_hub: 'Hub 不比较用例',
    commands_equal: '命令集合相等用例', commands_different: '命令集合不等用例', paths_gold_only: '只在 gold 的路径', paths_hub_only: '只在 Hub 的路径', paths_gold_abbreviated: '只在 gold 的路径中经缩写识别', paths_gold_via_no: '只在 gold 的路径中经 no 识别', paths_gold_single_word: '只在 gold 的路径中单词命令',
    unplaced_gold: 'gold 全部未归位用例', unplaced_hub: 'Hub 全部未归位用例', unplaced_gold_comparable: 'gold 可比较未归位用例', unplaced_hub_comparable: 'Hub 可比较未归位用例',
    unplaced_both: '可比较用例中两边都未归位', unplaced_gold_only: '可比较用例中只有 gold 未归位', unplaced_hub_only: '可比较用例中只有 Hub 未归位', steps_placed_in_hub_unplaced: 'Hub 可比较未归位用例中步骤有命令', entry_data_mismatches: '条目与数据命令集合不符用例', hub_entry_defects: 'Hub 输出条目缺陷',
  };
  return [...Object.entries(report.counts).map(([name, count]) => `${labels[name]}：${count}`), `gold SHA-256：${report.hashes.gold}`, `Hub SHA-256：${report.hashes.hub}`, `输入缺项：${report.incompleteSummary.reduce((n, v) => n + v.count, 0)}`, ...renderIncomplete(report.incompleteSummary), `判定：${report.verdict}`].join('\n');
}
export function main(argv: string[]): number {
  const usage = '用法：node scripts/real/accept/command-index.ts --gold <gold.json> --index <view.json> [--index …] [--out <report.json>]\n';
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!['--gold', '--index', '--out'].includes(key) || !value || value.startsWith('--') || key !== '--index' && flags.has(key)) { process.stderr.write(usage); return 2; }
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  if (!flags.has('--gold') || !flags.has('--index')) { process.stderr.write(usage); return 2; }
  let phase = '金标准';
  const read = (file: string): unknown => {
    let text: string; try { text = readFileSync(file, 'utf8'); } catch { throw new IndexInputError('read','文件不可读，请重新导出该类文件'); }
    try { return JSON.parse(text) as unknown; } catch { throw new IndexInputError('json','不是有效 JSON，请按原样重新导出'); }
  };
  try {
    const gold = read(flags.get('--gold')![0]) as CommandsGold;
    const views = flags.get('--index')!.map((file, i) => { phase = `索引分片 ${i + 1}`; return read(file); });
    phase = '输入核对'; const report = compareCommandIndex(gold, views);
    if (flags.has('--out')) { phase = '报告输出'; try { writeFileSync(flags.get('--out')![0], `${JSON.stringify(report, null, 2)}\n`); } catch { throw new IndexInputError('write','报告不可写，请换可写的输出位置'); } }
    process.stdout.write(`${renderIndexReport(report)}\n`); return report.verdict === '相等' ? 0 : 1;
  } catch (error) { process.stderr.write(`读取或比较失败：${phase}：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1]?.endsWith('/accept/command-index.ts')) process.exitCode = main(process.argv.slice(2));

export interface IncompleteCategory { category: string; count: number; missing: string; action: string }
/** Categories are fixed text. Raw reasons can contain private cursor, document and path values and stay in --out. */
export function summarizeIncomplete(reasons: readonly string[]): IncompleteCategory[] {
  const grouped = new Map<string, IncompleteCategory>();
  for (const reason of reasons) {
    let category = '其他输入缺项', missing = '可核验的本轮完整输入', action = '检查报告并重新导出所需证据';
    let increment = 1;
    if (reason.startsWith('单键截断')) { category = '单键截断'; missing = '文档键下被截掉的完整条目'; action = '交集成者协调提高单键上限后重导；only= 不能拆开同一键'; increment = Number(/^单键截断 (\d+)/.exec(reason)?.[1] ?? 1); }
    else if (reason.includes('截断')) { category = '分片截断'; missing = '完整索引分片'; action = '按 only= 分成更小分片后重新导出'; }
    else if (reason.includes('未读来源')) { category = '未读来源'; missing = '来源完整性'; action = '修复来源并重新生产根，再导出索引'; }
    else if (reason.includes('索引根')) { category = '根不一致'; missing = '同一产品同一构建根的分片'; action = '重新导出同一产品及构建根的全部分片'; }
    else if (reason.includes('请求全部')) { category = '缺少分片'; missing = '金标准文档对应的全部分片'; action = '补齐对应 only= 分片再比较'; }
    else if (reason.includes('没有索引视图')) { category = '没有视图'; missing = '索引导出文件'; action = '提供完整索引视图及其分片'; }
    else if (reason.includes('游标')) { category = '分页未完'; missing = '后续节点页'; action = '按 next 游标继续导出并追加到同一 JSONL'; }
    else if (reason.includes('data') || reason.includes('document') || reason.includes('node')) { category = '条目字段缺失'; missing = '完整用例字段'; action = '重新导出含 data.document 和 data.node 的节点页'; }
    else if (reason.includes('JSON') || reason.includes('应答为出错')) { category = '应答无效'; missing = '有效节点应答'; action = '修复读取失败并重新导出有效 JSONL'; }
    else if (reason.includes('必须同时给') || reason.includes('不能混用')) { category = '输入方式不完整'; missing = '前后构建一致的输入方式'; action = '前后同时提供 gold 或同时提供 nodes，不混用'; }
    const old = grouped.get(category); if (old) old.count += increment; else grouped.set(category, { category, count: increment, missing, action });
  }
  return [...grouped.values()].sort((a, b) => a.category < b.category ? -1 : a.category > b.category ? 1 : 0);
}
export function renderIncomplete(rows: readonly IncompleteCategory[]): string[] { return rows.map((v) => `输入不全：${v.category} ${v.count} 项；缺少${v.missing}；下一步：${v.action}`); }

function mergeIncomplete(rows:readonly IncompleteCategory[]):IncompleteCategory[]{const groups=new Map<string,IncompleteCategory>();for(const row of rows){const previous=groups.get(row.category);if(previous)previous.count+=row.count;else groups.set(row.category,{...row});}return [...groups.values()].sort((a,b)=>a.category<b.category?-1:a.category>b.category?1:0);}
