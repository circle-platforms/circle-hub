// Capability 3, case location, through the real client: the model starts the production run for one document and the Hub's
// answer is compared with the answer written down independently in the gold file (from the path convention of the owner's
// attribution scheme read by hand).
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

export interface BuildCandidateGold {
  name: string;
  family: string;
  base: string;
  /** The page's “build on” time, ISO YYYY-MM-DDTHH:mm:ss; compared when present. */
  built?: string | null;
  released?: string | null;
}

export interface WrittenBuildGold {
  name: string;
  classification: 'known' | 'other_line' | 'unknown';
  line?: string;
  base?: string;
}

export interface BuildCandidatesGold {
  candidates: BuildCandidateGold[];
  written?: WrittenBuildGold[];
}

export interface LocationGold {
  document: string;
  /** The product name to start the run with, and the product line it must be located in. */
  product: string;
  line: string;
  train?: string;
  buildCandidates?: BuildCandidateGold[] | BuildCandidatesGold;
  writtenBuilds?: WrittenBuildGold[];
}

interface ParsedCandidate {
  name: string;
  base: string;
  built: string | null;
  raw: string;
}

/** How many candidates Hub lists in full; mirrors MAX_LISTED in packs/workflow/case-location/functions/candidates.ts. */
export const MAX_LISTED = 12;

/** Maximum number of result pages to read with hub_get_nodes. */
export const MAX_PAGES = 6;

/**
 * Finds the first complete JSON object after "下一页：get_nodes " by counting curly braces,
 * parses it with JSON.parse, and extracts { reference, cursor }.
 * Returns null if the marker is not found or JSON has no reference/cursor.
 */
export function parseNextCall(text: string): { reference: string; cursor: string } | null {
  const marker = '下一页：get_nodes ';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;
  if (!/^\s*$/.test(text.slice(at + marker.length, start))) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          if (typeof parsed.reference === 'string' && typeof parsed.cursor === 'string') {
            return { reference: parsed.reference, cursor: parsed.cursor };
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

/** Extracts the 64-hex rec: reference from the start_run result text. */
export function parseRecReference(text: string): string | null {
  const match = /完整结果[^\n]*?\b(rec:[0-9a-fA-F]{64})\b/.exec(text);
  return match ? match[1] : null;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts gold candidates identically to Hub: built time descending, then by name; null/missing built time last. */
export function orderGoldCandidates(candidates: BuildCandidateGold[]): BuildCandidateGold[] {
  return [...candidates].sort((a, b) => {
    const aHas = typeof a.built === 'string' && a.built.length > 0;
    const bHas = typeof b.built === 'string' && b.built.length > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const byTime = (b.built ?? '').localeCompare(a.built ?? '');
      if (byTime !== 0) return byTime;
    }
    return compareText(a.name, b.name);
  });
}

/** Parses candidate builds and alias indications from the candidate section of the text. */
function parseReportedCandidates(text: string): ParsedCandidate[] {
  const at = text.search(/构建候选|候选构建/);
  if (at < 0) return [];
  const after = text.slice(at);
  const endMatch = /(?:\n\s*(?:写出的构建名|问题与未知|条目|要求项|规则|结果)|\n\n)/.exec(after);
  const section = endMatch ? after.slice(0, endMatch.index) : after;

  // One candidate per sentence: 名（族，基于 基础构建）制作于 …，已发布 …；分隔符是候选之间的“；”。
  const parts = section.split(/[、,\n]|[；;](?=(?:Rel|Beta)_|另有)/u);
  const candidates: ParsedCandidate[] = [];
  for (const part of parts) {
    const nameMatch = /(?:Rel|Beta)_[A-Za-z0-9_.\-]+/.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[0];
    const baseMatch = /(?:依据|基于|based\s+on)\s*((?:Rel|Beta)_[A-Za-z0-9_.\-]+)/i.exec(part);
    const base = baseMatch ? baseMatch[1] : name;
    const builtMatch = /制作于\s*([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s+([0-9]{2}:[0-9]{2}))?/.exec(part);
    const built = builtMatch ? `${builtMatch[1]}T${builtMatch[2] ?? '00:00'}:00` : null;
    candidates.push({ name, base, built, raw: part.trim() });
  }
  return candidates;
}

export default function scenario(gold: LocationGold): Scenario {
  const area = '用例定位';
  const pack = 'case-location';
  let reference: string | null = null;
  let pagesRead = 0;

  return {
    name: 'case-location',
    area,
    prompt: `请对敏捷平台上的测试脑图 ${gold.document} 做用例定位。`,
    respond: (turn) => {
      if (turn.index === 0) {
        reference = null;
        pagesRead = 0;
        return [{ tool: 'hub_start_run', input: { pack, product: gold.product, inputs: { documents: { external: `agile:mindmap:${gold.document}` } } } }];
      }

      const lastText = turn.toolResults.map((r) => r.text).join('\n');
      if (reference === null) {
        reference = parseRecReference(lastText);
      }

      if (reference !== null && pagesRead === 0) {
        pagesRead = 1;
        return [{ tool: 'hub_get_nodes', input: { reference } }];
      }

      if (pagesRead > 0 && pagesRead < MAX_PAGES) {
        const next = parseNextCall(lastText);
        if (next !== null) {
          pagesRead++;
          return [{ tool: 'hub_get_nodes', input: { reference: next.reference, cursor: next.cursor } }];
        }
      }

      return [{ text: '定位完成。' }];
    },
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const has = (needle: string): boolean => text.includes(needle);
      const checks: Check[] = [
        { area, name: '模型拿到了运行结果，不是错误', expected: '回答里有“运行 run_…”，没有“出错”', actual: has('运行 run_') && !has('出错：') ? '有运行结果' : text.slice(0, 120), ok: has('运行 run_') && !has('出错：') },
        { area, name: '要求项 location 满足', expected: 'location 用例定位：满足 1', actual: has('location 用例定位：满足 1') ? '满足 1' : '未满足', ok: has('location 用例定位：满足 1') },
        { area, name: '版本线与独立依据一致', expected: `版本 ${gold.line}（目录，置信度高）`, actual: has(`版本 ${gold.line}（目录，置信度高）`) ? '一致' : '不一致', ok: has(`版本 ${gold.line}（目录，置信度高）`) },
        { area, name: '产品线', expected: `产品线 apv`, actual: has('产品线 apv') ? '一致' : '不一致', ok: has('产品线 apv') },
      ];
      if (gold.train !== undefined) checks.splice(3, 0, { area, name: '发布火车与独立依据一致', expected: `发布火车 ${gold.train}`, actual: has(`发布火车 ${gold.train}`) ? '一致' : '不一致', ok: has(`发布火车 ${gold.train}`) });

      if (gold.buildCandidates !== undefined) {
        const goldCandidates: BuildCandidateGold[] = Array.isArray(gold.buildCandidates)
          ? gold.buildCandidates
          : gold.buildCandidates.candidates;
        const goldWritten: WrittenBuildGold[] = Array.isArray(gold.buildCandidates)
          ? (gold.writtenBuilds ?? [])
          : (gold.buildCandidates.written ?? gold.writtenBuilds ?? []);

        const reported = parseReportedCandidates(text);
        const orderedGold = orderGoldCandidates(goldCandidates);
        const expectedListed = orderedGold.slice(0, MAX_LISTED);
        const expectedNames = new Set(expectedListed.map((c) => c.name));
        const reportedNames = new Set(reported.map((c) => c.name));

        const missing = [...expectedNames].filter((n) => !reportedNames.has(n));
        const extra = [...reportedNames].filter((n) => !expectedNames.has(n));

        checks.push({
          area,
          name: '构建候选：Hub 报出的候选构建名集合与独立依据一致',
          expected: `共 ${expectedNames.size} 个（${[...expectedNames].sort().join('、')}）`,
          actual: missing.length === 0 && extra.length === 0
            ? `共 ${reportedNames.size} 个，集合一致`
            : `${missing.length > 0 ? `缺 ${missing.length} 个（${missing.join('、')}）` : ''}${missing.length > 0 && extra.length > 0 ? '，' : ''}${extra.length > 0 ? `多 ${extra.length} 个（${extra.join('、')}）` : ''}`,
          ok: missing.length === 0 && extra.length === 0,
        });

        // Assertion on "另有 N 个": N must equal goldCandidates.length - MAX_LISTED when > 0, otherwise no "另有"
        const expectedMore = Math.max(0, goldCandidates.length - MAX_LISTED);
        const moreMatch = /另有\s*(\d+)\s*个/.exec(text);
        const reportedMore = moreMatch ? Number(moreMatch[1]) : null;
        const moreOk = expectedMore > 0 ? reportedMore === expectedMore : reportedMore === null;

        checks.push({
          area,
          name: '构建候选：超出上限的候选构建计数与独立依据一致',
          expected: expectedMore > 0 ? `另有 ${expectedMore} 个` : '没有“另有”计数',
          actual: reportedMore !== null
            ? `另有 ${reportedMore} 个`
            : (expectedMore > 0 ? '未报告“另有”计数' : '没有“另有”计数'),
          ok: moreOk,
        });

        // Aliases must indicate their base build (checked only for listed candidates)
        for (const alias of expectedListed.filter((c) => c.name !== c.base)) {
          const item = reported.find((r) => r.name === alias.name);
          const aliasOk = item !== undefined && (item.base === alias.base || item.raw.includes(alias.base));
          checks.push({
            area,
            name: `候选别名 ${alias.name} 带出依据的构建 ${alias.base}`,
            expected: `注明依据构建 ${alias.base}`,
            actual: aliasOk ? `已带出依据构建 ${alias.base}` : (item ? `未注明依据构建（实际：${item.raw}）` : '未列出该候选'),
            ok: aliasOk,
          });
        }

        // The built time and the based-on base of every listed candidate the gold carries them for
        for (const gold of expectedListed) {
          if (gold.built === undefined && gold.base === undefined) continue;
          const item = reported.find((r) => r.name === gold.name);
          const expected: string[] = [];
          const actual: string[] = [];
          let ok = item !== undefined;
          if (gold.built !== undefined) {
            expected.push(`制作于 ${gold.built ?? '未知'}`);
            const got = item === undefined ? '' : item.built === null ? '制作时间未知' : item.built.replace('T', ' ').slice(0, 16);
            actual.push(got);
            const timeMatch = item !== undefined && (
              gold.built === null
                ? item.built === null
                : (item.built !== null && item.built.slice(0, 16) === gold.built.slice(0, 16))
            );
            ok = ok && timeMatch;
          }
          if (gold.base !== undefined && gold.base !== gold.name) {
            expected.push(`基于 ${gold.base}`);
            const got = item === undefined ? '' : item.base;
            actual.push(got === gold.base ? `基于 ${gold.base}` : `基于 ${got || '（未注明）'}`);
            ok = ok && item !== undefined && item.base === gold.base;
          }
          checks.push({
            area,
            name: `候选 ${gold.name} 的制作时间与基础构建与独立依据一致`,
            expected: expected.join('；'),
            actual: ok ? actual.join('；') : item === undefined ? '未列出该候选' : `不一致（${actual.join('；')}）`,
            ok,
          });
        }

        // Written build names classification
        for (const w of goldWritten) {
          let match = false;
          let actualDesc = '';
          if (w.classification === 'known') {
            match = text.includes(`写出的构建名 ${w.name} 是定位到的版本线的构建`) ||
                    text.includes(`写出的构建名 ${w.name} 是候选`) ||
                    new RegExp(`${w.name}[^\\n]*?(?:已知|定位到的版本线|候选)`).test(text);
            actualDesc = match ? '已知构建' : '未按已知报告';
          } else if (w.classification === 'other_line') {
            const lineMatch = w.line ? text.includes(w.line) : true;
            match = (text.includes(`写出的构建名 ${w.name} 属于版本线`) || text.includes('build_other_line') || new RegExp(`${w.name}[^\\n]*?(?:属于版本线|另一条线)`).test(text)) && lineMatch;
            actualDesc = match ? `属于另一条版本线${w.line ? ` ${w.line}` : ''}` : '未报告为别的版本线';
          } else {
            match = text.includes(`知识库不认识写出的构建名 ${w.name}`) ||
                    text.includes(`不认识写出的构建名 ${w.name}`) ||
                    new RegExp(`${w.name}[^\\n]*?(?:未知|不认识)`).test(text);
            actualDesc = match ? '知识库不认识（未知）' : '未报告为未知';
          }
          checks.push({
            area,
            name: `写出的构建名 ${w.name} 分类与独立依据一致（${w.classification}）`,
            expected: `分类为 ${w.classification}${w.line ? ` (${w.line})` : ''}`,
            actual: actualDesc,
            ok: match,
          });
        }
      }

      checks.push({ area, name: '回答没有超过客户端能转交的长度', expected: '每个工具结果不超过 30000 个字符', actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`, ok: resultTexts(turns).every((t) => t.length <= 30_000) });
      return checks;
    },
  };
}
