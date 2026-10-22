// Capability 3, case location, through the real client: the model starts the production run for one document and the Hub's
// answer is compared with the answer written down independently in the gold file (from the path convention of the owner's
// attribution scheme read by hand).
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

export interface BuildCandidateGold {
  name: string;
  family: string;
  base: string;
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
  raw: string;
}

/** Parses candidate builds and alias indications from the candidate section of the text. */
function parseReportedCandidates(text: string): ParsedCandidate[] {
  const at = text.search(/构建候选|候选构建/);
  if (at < 0) return [];
  const after = text.slice(at);
  const endMatch = /(?:\n\s*(?:写出的构建名|问题与未知|条目|要求项|规则|结果)|\n\n)/.exec(after);
  const section = endMatch ? after.slice(0, endMatch.index) : after;

  const parts = section.split(/[、,;\n]/);
  const candidates: ParsedCandidate[] = [];
  for (const part of parts) {
    const nameMatch = /(?:Rel|Beta)_[A-Za-z0-9_.\-]+/.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[0];
    const baseMatch = /(?:依据|基于|based\s+on)\s*((?:Rel|Beta)_[A-Za-z0-9_.\-]+)/i.exec(part);
    const base = baseMatch ? baseMatch[1] : name;
    candidates.push({ name, base, raw: part.trim() });
  }
  return candidates;
}

export default function scenario(gold: LocationGold): Scenario {
  const area = '用例定位';
  return {
    name: 'case-location',
    area,
    prompt: `请对敏捷平台上的测试脑图 ${gold.document} 做用例定位。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack: 'case-location@1.0.0', product: gold.product, inputs: { documents: { external: `agile:mindmap:${gold.document}` } } } }]
        : [{ text: '定位完成。' }],
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
        const goldNames = new Set(goldCandidates.map((c) => c.name));
        const reportedNames = new Set(reported.map((c) => c.name));

        const missing = [...goldNames].filter((n) => !reportedNames.has(n));
        const extra = [...reportedNames].filter((n) => !goldNames.has(n));

        checks.push({
          area,
          name: '构建候选：Hub 报出的候选构建名集合与独立依据一致',
          expected: `共 ${goldNames.size} 个（${[...goldNames].sort().join('、')}）`,
          actual: missing.length === 0 && extra.length === 0
            ? `共 ${reportedNames.size} 个，集合一致`
            : `${missing.length > 0 ? `缺 ${missing.length} 个（${missing.join('、')}）` : ''}${missing.length > 0 && extra.length > 0 ? '，' : ''}${extra.length > 0 ? `多 ${extra.length} 个（${extra.join('、')}）` : ''}`,
          ok: missing.length === 0 && extra.length === 0,
        });

        // Aliases must indicate their base build
        for (const alias of goldCandidates.filter((c) => c.name !== c.base)) {
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
