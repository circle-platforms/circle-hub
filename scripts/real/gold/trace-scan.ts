// Independent build scan over exported originals only. No Hub or pack runtime imports.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoldRefusal, loadCaseMaps, missingMapDocuments, parseDocumentList, parsePlmResponses, traceGold } from './trace.ts';
import { parseClosedStatuses } from './join.ts';

export function main(argv: string[], print = (line: string) => process.stdout.write(`${line}\n`)): number {
  const value = (key: string) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
  const fixedDir = value('fixed-dir'), casesDir = value('cases-dir'), treePath = value('tree'), out = value('out');
  const missing = [!fixedDir && '--fixed-dir', !casesDir && '--cases-dir', !treePath && '--tree', !out && '--out'].filter((f): f is string => f !== false);
  if (missing.length > 0) { process.stderr.write(`缺 ${missing.join('、')}\n用法：node scripts/real/gold/trace-scan.ts --fixed-dir <目录> --cases-dir <目录> --tree <敏捷树导出> [--docs-dir <目录>] [--plm <文件>…] [--closed-statuses <文件>] [--case-rule marked|tagged] --out <文件>\n`); return 2; }
  if (!existsSync(fixedDir!) || readdirSync(fixedDir!).filter((f) => /^Bugs_Fixed_with_.+\.html$/i.test(f)).length === 0) {
    process.stderr.write('没有 Bugs_Fixed_with_<构建>.html：先导出修复缺陷页\n');
    return 1;
  }
  try {
    let tree: unknown;
    try {
      tree = JSON.parse(readFileSync(treePath!, 'utf8'));
    } catch {
      throw new GoldRefusal('敏捷树导出读不了或不是 JSON：重新导出敏捷树');
    }
    // Parse the maps once for the whole scan and filter them per build: re-reading every map per build made the
    // integrator's full scan (all builds, no --docs-dir) quadratic.
    const allMaps = loadCaseMaps(casesDir!);
    const mapsByDocument = new Map(allMaps.map((m) => [m.document, m]));
    const plmPaths: string[] = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--plm') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) plmPaths.push(...argv[++i].split(','));
    }
    let plm: ReturnType<typeof parsePlmResponses> | undefined;
    if (plmPaths.length > 0) {
      try {
        plm = parsePlmResponses(plmPaths.map((p) => readFileSync(p, 'utf8')));
      } catch {
        throw new GoldRefusal('PLM 原件读不了或不是 JSON：重新导出 plm:bugs:');
      }
    }
    const closedPath = value('closed-statuses');
    let closedStatuses: ReturnType<typeof parseClosedStatuses> | undefined;
    if (closedPath) {
      try {
        closedStatuses = parseClosedStatuses(JSON.parse(readFileSync(closedPath, 'utf8')));
      } catch (error) {
        if (error instanceof GoldRefusal) throw error;
        throw new GoldRefusal('关闭状态表不是 JSON：检查导出的关闭状态表');
      }
    }
    const docsDir = value('docs-dir');
    const buildsRaw = readdirSync(fixedDir!).sort().filter((f) => /^Bugs_Fixed_with_.+\.html$/i.test(f)).map((file, index) => {
      const build = file.replace(/^Bugs_Fixed_with_/i, '').replace(/\.html$/i, '');
      const at = index + 1;
      let allowed: Set<string> | undefined;
      if (docsDir) {
        try {
          allowed = parseDocumentList(readFileSync(join(docsDir, `${build}.json`), 'utf8'));
        } catch {
          // Stage-named with the build's scan index (item 8): never the path or the raw error.
          throw new GoldRefusal(`#${at} 的文档清单不存在：先导出这个构建的文档清单`);
        }
      }
      // An empty per-build list is not a silent filter-everything (the 10-23 incident class): the build says so and
      // stays out of the ranking.
      if (allowed !== undefined && allowed.size === 0) return { index: at, build, digest: createHash('sha256').update(build).digest('hex').slice(0, 12), emptyList: true as const };
      const maps = allowed === undefined ? allMaps : allMaps.filter((m) => allowed.has(m.document) || allowed.has(`${m.document}.json`) || allowed.has(`agile:case:${m.document}`));
      if (allowed !== undefined) {
        // A listed document with no exported map is a missing input: refuse and name the counts, never drop silently.
        const missing = missingMapDocuments(allowed, maps);
        if (missing.length > 0) throw new GoldRefusal(`#${at} 的文档清单 ${allowed.size} 份，导出的脑图缺 ${missing.length} 份：用 circle-hub original export 导出后重跑`);
      }
      const gold = traceGold({ html: readFileSync(join(fixedDir!, file), 'utf8'), tree, maps, plm, closedStatuses, build, caseRule: value('case-rule') === 'tagged' ? 'tagged' : 'marked' });
      // Without --plm the closed counts were never read: they stay null (unread), never 0 (the owner's rule — an
      // unknown is transient and names the missing fact and the next action).
      const unread = plm === undefined;
      // A traced defect whose status PLM never answered (a partly exported plm:bugs: original).
      const unreadTraced = gold.defects.filter((d) => d.cases.length > 0 && (d.defect_system_status === undefined || d.defect_system_status === null) && d.defect_system_unknown_reason !== undefined && d.defect_system_unknown_reason !== null).length;
      return { index: at, build, digest: createHash('sha256').update(build).digest('hex').slice(0, 12), defects: gold.defects.length, traced: gold.defects.filter((d) => d.cases.length > 0).length, closed: unread ? null : gold.closed_defects ?? 0, closed_traced: unread ? null : gold.closed_traced ?? 0, status_unknown: unread ? null : gold.status_unknown ?? 0, unread_traced: unread ? null : unreadTraced };
    });
    const builds = buildsRaw.filter((b) => !('emptyList' in b));
    const scans = builds as Array<{ index: number; build: string; digest: string; defects: number; traced: number; closed: number | null; closed_traced: number | null; status_unknown: number | null; unread_traced: number | null }>;
    const read = scans.filter((b) => b.closed_traced !== null);
    const ranked = [...(read.length > 0 ? read : scans)].sort((a, b) => (b.closed_traced ?? 0) - (a.closed_traced ?? 0) || b.traced - a.traced || a.index - b.index);
    const recommendation = ranked[0]?.traced ? ranked[0].index : null;
    writeFileSync(resolve(out!), `${JSON.stringify({ document_filter: docsDir ? '按构建的文档清单筛选' : '没有按构建的文档清单筛选，使用全部脑图', builds: buildsRaw, recommendation }, null, 2)}\n`);
    for (const b of buildsRaw) if ('emptyList' in b) print(`#${b.index} 的文档清单是空的：这个构建没有列出文档，不进建议`);
    const unreadPlm = plm === undefined;
    for (const b of scans) print(`#${b.index}：缺陷 ${b.defects}；已追溯 ${b.traced}；${unreadPlm ? '已关闭 未读（没给 --plm）；其中已追溯 未读；状态未知 未读（没给 --plm）' : `${(b.status_unknown ?? 0) > 0 ? `已关闭 ≥${b.closed}（${b.status_unknown} 个状态未读）` : `已关闭 ${b.closed}`}，其中已追溯 ${b.closed_traced}；状态未知 ${b.status_unknown}`}`);
    const nothingTraced = scans.every((b) => b.traced === 0);
    if (unreadPlm) {
      // Nothing traced anywhere is a fact, not a default recommendation.
      if (nothingTraced) print('没有已追溯的缺陷');
      else print(`没给 PLM 原件，已关闭数未知：按已追溯数建议 #${recommendation ?? 1}；导出 plm:bugs: 原件后加 --plm --closed-statuses 重扫`);
    } else {
      if (recommendation !== null) print(`建议用 #${recommendation}`);
      if (!ranked[0]?.closed_traced) {
        // A traced defect whose status was never read names the build and the next action: the unknown is
        // transient, never a bare absence.
        const unreadBuild = scans.filter((b) => (b.unread_traced ?? 0) > 0).sort((a, b) => (b.unread_traced ?? 0) - (a.unread_traced ?? 0) || a.index - b.index)[0];
        if (unreadBuild !== undefined) print(`#${unreadBuild.index} 有 ${unreadBuild.unread_traced} 个已追溯缺陷状态未读：对 #${unreadBuild.index} 开追溯运行，导出 plm:bugs: 原件后加 --plm 重扫`);
        else print('没有找到已追溯的已关闭缺陷');
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof GoldRefusal) {
      process.stderr.write(`${error.line}\n`);
      return 1;
    }
    // Anything unexpected is named by stage only (item 8): a raw message would carry paths, build names or map
    // content onto the screen.
    process.stderr.write(`扫描失败（${(error as Error)?.constructor?.name ?? 'Error'}）：检查导出文件与文档清单\n`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
