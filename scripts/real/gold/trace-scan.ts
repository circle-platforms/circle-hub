// Independent build scan over exported originals only. No Hub or pack runtime imports.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCaseMaps, parseDocumentList, parsePlmResponses, traceGold } from './trace.ts';
import { parseClosedStatuses } from './join.ts';

export function main(argv: string[], print = (line: string) => process.stdout.write(`${line}\n`)): number {
  const value = (key: string) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
  const fixedDir = value('fixed-dir'), casesDir = value('cases-dir'), treePath = value('tree'), out = value('out');
  if (!fixedDir || !casesDir || !treePath || !out) return 2;
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
      return { index: index + 1, build, digest: createHash('sha256').update(build).digest('hex').slice(0, 12), defects: gold.defects.length, traced: gold.defects.filter((d) => d.cases.length > 0).length, closed: gold.closed_defects ?? 0, closed_traced: gold.closed_traced ?? 0, status_unknown: gold.status_unknown ?? 0 };
    });
    const ranked = [...builds].sort((a, b) => b.closed_traced - a.closed_traced || b.traced - a.traced || a.index - b.index);
    const recommendation = ranked[0]?.traced ? ranked[0].index : null;
    writeFileSync(resolve(out), `${JSON.stringify({ document_filter: docsDir ? '按构建的文档清单筛选' : '没有按构建的文档清单筛选，使用全部脑图', builds, recommendation }, null, 2)}\n`);
    for (const b of builds) print(`#${b.index}：缺陷 ${b.defects}；已追溯 ${b.traced}；已关闭 ${b.closed}，其中已追溯 ${b.closed_traced}；状态未知 ${b.status_unknown}`);
    if (recommendation !== null) print(`建议用 #${recommendation}`);
    if (!ranked[0]?.closed_traced) print('没有找到已追溯的已关闭缺陷');
    return 0;
  } catch { process.stderr.write('扫描失败：检查导出文件、文档清单和关闭状态表\n'); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
