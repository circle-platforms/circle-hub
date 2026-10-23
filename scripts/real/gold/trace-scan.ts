// Independent build scan over exported originals only. No Hub or pack runtime imports.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCaseMaps, parseDocumentList, parsePlmResponses, traceGold } from './trace.ts';
import { parseClosedStatuses } from './join.ts';

export function main(argv: string[], print = (line: string) => process.stdout.write(`${line}\n`)): number {
  const value = (key: string) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
  const fixedDir = value('fixed-dir'), casesDir = value('cases-dir'), treePath = value('tree'), out = value('out');
  const missing = [!fixedDir && '--fixed-dir', !casesDir && '--cases-dir', !treePath && '--tree', !out && '--out'].filter((f): f is string => f !== false);
  if (missing.length > 0) { process.stderr.write(`缺 ${missing.join('、')}\n用法：node scripts/real/gold/trace-scan.ts --fixed-dir <目录> --cases-dir <目录> --tree <敏捷树导出> [--docs-dir <目录>] [--plm <文件>…] [--closed-statuses <文件>] [--case-rule marked|tagged] --out <文件>\n`); return 2; }
  if (!existsSync(fixedDir) || readdirSync(fixedDir).filter((f) => /^Bugs_Fixed_with_.+\.html$/i.test(f)).length === 0) {
    process.stderr.write('没有 Bugs_Fixed_with_<构建>.html：先导出修复缺陷页\n');
    return 1;
  }
  try {
    const tree = JSON.parse(readFileSync(treePath, 'utf8'));
    const plmPaths: string[] = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--plm') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) plmPaths.push(...argv[++i].split(','));
    }
    const plm = plmPaths.length ? parsePlmResponses(plmPaths.map((p) => readFileSync(p, 'utf8'))) : undefined;
    const closedPath = value('closed-statuses');
    const closedStatuses = closedPath ? parseClosedStatuses(JSON.parse(readFileSync(closedPath, 'utf8'))) : undefined;
    const docsDir = value('docs-dir');
    const builds = readdirSync(fixedDir).sort().filter((f) => /^Bugs_Fixed_with_.+\.html$/i.test(f)).map((file, index) => {
      const build = file.replace(/^Bugs_Fixed_with_/i, '').replace(/\.html$/i, '');
      const allowed = docsDir ? parseDocumentList(readFileSync(join(docsDir, `${build}.json`), 'utf8')) : undefined;
      const gold = traceGold({ html: readFileSync(join(fixedDir, file), 'utf8'), tree, maps: loadCaseMaps(casesDir, allowed), plm, closedStatuses, build, caseRule: value('case-rule') === 'tagged' ? 'tagged' : 'marked' });
      // Without --plm the closed counts were never read: they stay null (unread), never 0 (the owner's rule — an
      // unknown is transient and names the missing fact and the next action).
      const unread = plm === undefined;
      return { index: index + 1, build, digest: createHash('sha256').update(build).digest('hex').slice(0, 12), defects: gold.defects.length, traced: gold.defects.filter((d) => d.cases.length > 0).length, closed: unread ? null : gold.closed_defects ?? 0, closed_traced: unread ? null : gold.closed_traced ?? 0, status_unknown: unread ? null : gold.status_unknown ?? 0 };
    });
    const read = builds.filter((b) => b.closed_traced !== null) as Array<typeof builds[number]>;
    const ranked = [...(read.length > 0 ? read : builds)].sort((a, b) => (b.closed_traced ?? 0) - (a.closed_traced ?? 0) || b.traced - a.traced || a.index - b.index);
    const recommendation = ranked[0]?.traced ? ranked[0].index : null;
    writeFileSync(resolve(out), `${JSON.stringify({ document_filter: docsDir ? '按构建的文档清单筛选' : '没有按构建的文档清单筛选，使用全部脑图', builds, recommendation }, null, 2)}\n`);
    const unreadPlm = plm === undefined;
    for (const b of builds) print(`#${b.index}：缺陷 ${b.defects}；已追溯 ${b.traced}；${unreadPlm ? '已关闭 未读（没给 --plm）；其中已追溯 未读；状态未知 未读（没给 --plm）' : `已关闭 ${b.closed}，其中已追溯 ${b.closed_traced}；状态未知 ${b.status_unknown}`}`);
    if (unreadPlm) {
      print(`没给 PLM 原件，已关闭数未知：按已追溯数建议 #${recommendation ?? 1}；导出 plm:bugs: 原件后加 --plm --closed-statuses 重扫`);
    } else {
      if (recommendation !== null) print(`建议用 #${recommendation}`);
      if (!ranked[0]?.closed_traced) print('没有找到已追溯的已关闭缺陷');
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (/closed/i.test(message) || /statuses/i.test(message)) process.stderr.write(`关闭状态表不是数组也不是 {statuses: [...]}\n`);
    else if (/清单|document/i.test(message)) process.stderr.write(`#k 的文档清单读不了或列的不是数组\n`);
    else process.stderr.write(`扫描失败：${message.split('\n')[0]?.slice(0, 120) ?? '检查导出文件与文档清单'}\n`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
