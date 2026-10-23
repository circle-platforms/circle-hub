// Independent board answer from mindmaps and agile tree originals. No Hub/pack runtime imports.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardGold, BoardGroupGold } from '../accept/quality-board.ts';
import { caseGold, NoCaseNodes } from './cases.ts';
import { locationsGold, lineKey } from './locations.ts';
import { cleanDocId, GoldRefusal, loadCaseMaps, missingMapDocuments, parseDocumentList } from './trace.ts';
import { boardLocate } from './board-locate.ts';

// Independent normalization over a copied declaration, never a pack-computed result.
// Declaration source: packs/workflow/template-gap/functions/tags.ts and tables/template-v3.json; no computed results copied.
export const TAG_SPELLINGS = {
  Functional: ['functional', 'function', 'functions', 'functionality', 'func', '功能', '功能性', '基本功能'],
  Configuration: ['configuration', 'configurations', 'config', 'configs', 'configure', 'cfg', '配置'],
  Integration: ['integration', 'integrations', 'integrated', 'integrate', '集成'],
  Compatibility: ['compatibility', 'compatible', 'compat', '兼容', '兼容性'],
  Negative: ['negative', 'neg', '负向', '负面', '反向', '逆向', '异常'],
  Stress: ['stress', 'pressure', '压力', '压测'],
} as const;
export const TYPE_LABELS = { Functional: '功能测试', Configuration: '配置测试', Integration: '集成测试', Compatibility: '兼容性测试', Negative: '反向测试', Stress: '压力测试' } as const;

export function testType(raw: string): string | null {
  // Independently strip edge punctuation and fold aliases, then try declared suffixes.
  let key = raw.normalize('NFKC').replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/g, '').toLowerCase();
  if (raw.length > 200) return null;
  const edges = '[]【】()（）{}<>《》「」『』"\'“”‘’`#*.,;:!?。，；：！？、 ';
  while (key.length && edges.includes(key[0])) key = key.slice(1);
  while (key.length && edges.includes(key[key.length - 1])) key = key.slice(0, -1);
  key = key.replace(/[\s_-]/g, '');
  const candidates = [key];
  for (const suffix of ['测试用例', 'testing', 'tests', 'cases', '测试', '用例', 'test', 'case']) if (key.endsWith(suffix)) candidates.push(key.slice(0, -suffix.length));
  for (const candidate of candidates) for (const [type, aliases] of Object.entries(TAG_SPELLINGS)) if ((aliases as readonly string[]).includes(candidate)) return TYPE_LABELS[type as keyof typeof TYPE_LABELS];
  return null;
}

export function boardGold(options: { product: string; build: string; tree: unknown; maps: Array<{ document: string; map: unknown }>; caseRule?: 'marked' | 'tagged'; types?: boolean }): BoardGold & { documents: { count: number; not_in_tree: number; no_cases: number } } {
  const locations = locationsGold(options.tree).all ?? [];
  const groups = new Map<string, BoardGroupGold>();
  let notInTree = 0, noCases = 0;
  for (const map of options.maps) {
    const location = locations.find((l) => cleanDocId(l.document) === cleanDocId(map.document));
    if (!location) notInTree++;
    // The board groups follow the product pack's own locate rule (README 177-180), not the case-location rule: the
    // line is the nearest line label above the first train (a version mismatch is only a note there), and modules
    // like Build工具/缺陷管理 stay modules.
    const boardLocation = location === undefined ? null : boardLocate([location.title, ...location.ancestors].slice(1));
    let doc;
    try { doc = caseGold([map], { caseRule: options.caseRule }).documents[0]; }
    catch (error) { if (error instanceof NoCaseNodes) { noCases++; continue; } throw error; }
    const label = `${boardLocation?.line ? lineKey(boardLocation.line) : 'unplaced'}/${boardLocation?.module || 'unplaced'}`;
    const held = groups.get(label) ?? { label, cases: 0, missing: 0, vague: 0, negative: 0 };
    for (const c of doc.items) {
      if (options.types) {
        held.coverage ??= { present: [], missing: [], untagged: 0 };
        if (c.tags.length === 0) held.coverage.untagged++;
        for (const raw of c.tags) { const label = testType(raw); if (label && !held.coverage.present.includes(label)) held.coverage.present.push(label); }
      }
      held.cases++;
      if (!c.hasExpected) held.missing++;
      if (c.vagueExpected) held.vague++;
      if (c.negative) held.negative++;
    }
    groups.set(label, held);
  }
  for (const group of groups.values()) if (group.coverage) {
    group.coverage.present = Object.values(TYPE_LABELS).filter((label) => group.coverage!.present.includes(label));
    group.coverage.missing = Object.values(TYPE_LABELS).filter((label) => !group.coverage!.present.includes(label));
  }
  const sorted = [...groups.values()].sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return { types: options.types ?? false, product: options.product, build: options.build, groups: sorted, totals: sorted.reduce((sum, g) => ({ cases: sum.cases + g.cases, missing: sum.missing + g.missing, vague: sum.vague + g.vague, negative: sum.negative + g.negative }), { cases: 0, missing: 0, vague: 0, negative: 0 }), documents: { count: options.maps.length, not_in_tree: notInTree, no_cases: noCases } };
}
/** Validate the independent measurement before interpreting missing rows as zero. */
function measuredUnplaced(raw: unknown, listed: ReadonlySet<string>): number {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const refuse = (detail: string): never => { throw new GoldRefusal(`case-commands 独立答案${detail}：按这个构建的清单重跑 case-commands.ts`); };
  if (!record(raw) || !Array.isArray(raw.cases)) return refuse('里 cases 不是数组');
  if (raw.schema !== 'case-commands-gold@1' || typeof raw.tree_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.tree_sha256)) return refuse('的格式或命令树摘要无效');
  if (!Array.isArray(raw.documents) || raw.documents.some(doc => typeof doc !== 'string' || cleanDocId(doc) === '')) return refuse('里 documents 不是有效文档清单');
  const documents = new Set((raw.documents as string[]).map(cleanDocId));
  if (documents.size !== raw.documents.length || !record(raw.document_cases)) return refuse('里 document_cases 不是有效文档计数');
  const counts = new Map<string, number>();
  for (const [doc, count] of Object.entries(raw.document_cases)) {
    const id = cleanDocId(doc);
    if (!documents.has(id) || counts.has(id) || !Number.isSafeInteger(count) || Number(count) < 0) return refuse('的文档计数与清单不一致');
    counts.set(id, Number(count));
  }
  if (counts.size !== documents.size) return refuse('的文档计数没有覆盖文档清单');
  const match = (value: unknown): boolean => record(value) && typeof value.path === 'string' && value.path.startsWith('/commands/')
    && typeof value.abbreviated === 'boolean' && typeof value.via_no === 'boolean' && Number.isSafeInteger(value.words) && Number(value.words) > 0;
  const rows: Array<{document:string; paths:unknown[]}> = [];
  const observed = new Map<string, number>();
  for (const value of raw.cases) {
    if (!record(value) || typeof value.document !== 'string' || !documents.has(cleanDocId(value.document)) || typeof value.comparable !== 'boolean'
      || !Array.isArray(value.paths) || !value.paths.every(match) || !Array.isArray(value.steps) || !value.steps.every(match)) return refuse('的用例行或命令路径无效');
    const document = cleanDocId(value.document);
    rows.push({document, paths:value.paths}); observed.set(document, (observed.get(document) ?? 0) + 1);
  }
  for (const [doc, count] of counts) if ((observed.get(doc) ?? 0) !== count) return refuse('的用例行数与文档计数不一致');
  const required = new Set([...listed].map(cleanDocId));
  const missing = [...required].filter(doc => !documents.has(doc));
  if (missing.length > 0) throw new GoldRefusal(`case-commands 独立答案缺 ${missing.length} 份文档：按这个构建的清单重跑 case-commands.ts`);
  return rows.filter(row => required.has(row.document) && row.paths.length === 0).length;
}

export function main(argv: string[], print = (line: string) => process.stdout.write(`${line}\n`)): number {
  const value = (key: string) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
  const tree = value('tree'), cases = value('cases-dir'), docs = value('docs'), product = value('product'), build = value('build'), out = value('out');
  const missing = [!tree && '--tree', !cases && '--cases-dir', !docs && '--docs', !product && '--product', !build && '--build', !out && '--out'].filter((f): f is string => f !== false);
  if (missing.length > 0) { process.stderr.write(`缺 ${missing.join('、')}\n用法：node scripts/real/gold/board.ts --tree <敏捷树导出> --cases-dir <目录> --docs <文档清单> --product <产品> --build <构建> [--case-rule marked|tagged] [--types] [--placement | --case-commands <case-commands.json>] --out <文件>\n`); return 2; }
  try {
    let listed: Set<string>;
    try {
      listed = parseDocumentList(readFileSync(docs!, 'utf8'));
    } catch {
      throw new GoldRefusal('文档清单读不了：先导出这个构建的文档清单');
    }
    if (listed.size === 0) { process.stderr.write('文档清单是空的：补上这个构建的文档清单\n'); return 1; }
    const maps = loadCaseMaps(cases!, listed);
    // A listed document with no exported map is a missing input: refuse to start and say what to supply (the 10-23
    // incident: a silently dropped document computed the gold on a subset). The check lives in trace.ts, shared.
    const missing = missingMapDocuments(listed, maps);
    if (missing.length > 0) { process.stderr.write(`清单 ${listed.size} 份，导出的脑图缺 ${missing.length} 份：用 circle-hub original export 导出后重跑\n`); return 1; }
      let treeJson: unknown;
      try {
        treeJson = JSON.parse(readFileSync(tree!, 'utf8'));
      } catch {
        throw new GoldRefusal('敏捷树导出读不了或不是 JSON：重新导出敏捷树');
      }
      const gold = boardGold({ types: argv.includes('--types'), product: product!, build: build!, tree: treeJson, maps, caseRule: value('case-rule') === 'tagged' ? 'tagged' : 'marked' });
    // --case-commands: the unplaced count from the independent case-to-command gold of the gold-case-commands work
    // item (its out JSON: comparable cases with no parsed path; only cases of THIS build's documents count).
    const caseCommandsPath = value('case-commands');
    if (caseCommandsPath !== undefined) {
      let commands: unknown;
      try {
        commands = JSON.parse(readFileSync(caseCommandsPath, 'utf8'));
      } catch {
        throw new GoldRefusal('case-commands 独立答案不是 JSON：按这个构建的清单重跑 case-commands.ts');
      }
      const unplaced = measuredUnplaced(commands, listed);
      (gold as { unplaced?: number }).unplaced = unplaced;
      (gold as { placement?: boolean }).placement = true;
    }
    // --placement (quality-board 1.1.0 requires the slot): bind it without an independent count. A run against
    // 1.1+ needs one of --placement, --case-commands or --types.
    if (argv.includes('--placement') && !('placement' in gold)) {
      (gold as { placement?: boolean }).placement = true;
    }
    writeFileSync(out!, `${JSON.stringify(gold, null, 2)}\n`);
    print(`清单 ${listed.size} 份，导出的脑图 ${gold.documents.count} 份，其中不在树里 ${gold.documents.not_in_tree} 份，没有用例 ${gold.documents.no_cases} 份`);
    print(`分组 ${gold.groups!.length} 组；用例 ${gold.totals!.cases}；无期望 ${gold.totals!.missing}；含糊 ${gold.totals!.vague}；负面 ${gold.totals!.negative}`);
    print(`指标计数 SHA-256 ${createHash('sha256').update(JSON.stringify(gold.groups!.map(({ cases, missing, vague, negative }) => ({ cases, missing, vague, negative })).sort((a, b) => a.cases - b.cases || a.missing - b.missing || a.vague - b.vague || a.negative - b.negative))).digest('hex').slice(0, 12)}`);
    return 0;
  } catch (error) {
    if (error instanceof GoldRefusal) {
      process.stderr.write(`${error.line}\n`);
      return 1;
    }
    // Stage only, never the raw message (item 8): a raw message would carry paths or file content on screen.
    process.stderr.write(`生成看板独立答案失败（${(error as Error)?.constructor?.name ?? 'Error'}）：检查原始文件与文档清单\n`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
