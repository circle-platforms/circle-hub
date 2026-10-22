// Capability 3, case location, through the real client (architecture 6b):
// The model starts the production run for a document or a list of documents (at least 5, covering different lines and modules).
// The Hub's answers are compared with the gold file: version line, release train, module, build candidates,
// and associated story and defect numbers, with each associated number queried in the defect system via hub-call.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import {
  MAX_PAGES,
  createPagerState,
  pagedRespond,
  parseNextCall,
  parseRecReference,
} from '../lib/pager.ts';
import type { Check } from '../lib/report.ts';
import { callTools, type CallOptions } from '../hub-call.ts';

export { MAX_PAGES, parseNextCall, parseRecReference };

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

export interface DocumentLocationGold {
  document: string;
  product?: string;
  line: string;
  train?: string;
  module?: string;
  stories?: string[];
  bugs?: string[];
  associatedIds?: string[];
  /** Record of whether associated IDs were verified in PLM (plm:bug / plm:story). */
  plmFound?: Record<string, boolean>;
  buildCandidates?: BuildCandidateGold[] | BuildCandidatesGold;
  writtenBuilds?: WrittenBuildGold[];
}

export interface LocationListGold {
  product?: string;
  documents: DocumentLocationGold[];
}

export type LocationGold = DocumentLocationGold | LocationListGold;

interface ParsedCandidate {
  name: string;
  base: string;
  built: string | null;
  raw: string;
}

/** How many candidates Hub lists in full; mirrors MAX_LISTED in packs/workflow/case-location/functions/candidates.ts. */
export const MAX_LISTED = 12;

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
export function parseReportedCandidates(text: string): ParsedCandidate[] {
  const match = /版本线\s+\S+\s+的构建候选\s+\d+\s+个/.exec(text);
  if (!match) return [];
  const after = text.slice(match.index);
  const endMatch = /(?:另有\s*\d+\s*个|(?:\n\s*(?:写出的构建名|问题与未知|条目|要求项|规则|结果)|\n\n)|[。])/u.exec(after);
  const section = endMatch ? after.slice(0, endMatch.index) : after;

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

/** Queries defect/story ID in PLM via Hub MCP tools. */
export async function checkPlmId(
  options: CallOptions,
  kind: 'bug' | 'story',
  id: string,
): Promise<{ id: string; kind: 'bug' | 'story'; found: boolean; detail?: string }> {
  try {
    const results = await callTools(options, [
      {
        tool: 'hub_start_run',
        args: {
          pack: 'defect-to-case',
          inputs: {
            defects: [{ external: `plm:${kind}:${id}` }],
          },
        },
      },
    ]);
    const first = results[0];
    if (!first || first.isError) {
      return { id, kind, found: false, detail: first?.text };
    }
    const notFound = first.text.includes('来源不可用') || first.text.includes('PROJECTION_FAILED') || first.text.includes('SOURCE_UNAVAILABLE');
    return { id, kind, found: !notFound, detail: first.text };
  } catch (error) {
    return { id, kind, found: false, detail: (error as Error).message };
  }
}

function checkCandidateBuilds(
  area: string,
  text: string,
  goldCandidatesInput: BuildCandidateGold[] | BuildCandidatesGold,
  writtenBuildsInput?: WrittenBuildGold[],
  docPrefix = '',
): Check[] {
  const checks: Check[] = [];
  const goldCandidates: BuildCandidateGold[] = Array.isArray(goldCandidatesInput)
    ? goldCandidatesInput
    : goldCandidatesInput.candidates;
  const goldWritten: WrittenBuildGold[] = Array.isArray(goldCandidatesInput)
    ? (writtenBuildsInput ?? [])
    : (goldCandidatesInput.written ?? writtenBuildsInput ?? []);

  const reported = parseReportedCandidates(text);
  const orderedGold = orderGoldCandidates(goldCandidates);
  const expectedListed = orderedGold.slice(0, MAX_LISTED);
  const expectedNames = new Set(expectedListed.map((c) => c.name));
  const reportedNames = new Set(reported.map((c) => c.name));

  const missing = [...expectedNames].filter((n) => !reportedNames.has(n));
  const extra = [...reportedNames].filter((n) => !expectedNames.has(n));

  checks.push({
    area,
    name: `${docPrefix}构建候选：Hub 报出的候选构建名集合与独立依据一致`,
    expected: `共 ${expectedNames.size} 个（${[...expectedNames].sort().join('、')}）`,
    actual: missing.length === 0 && extra.length === 0
      ? `共 ${reportedNames.size} 个，集合一致`
      : `${missing.length > 0 ? `缺 ${missing.length} 个（${missing.join('、')}）` : ''}${missing.length > 0 && extra.length > 0 ? '，' : ''}${extra.length > 0 ? `多 ${extra.length} 个（${extra.join('、')}）` : ''}`,
    ok: missing.length === 0 && extra.length === 0,
  });

  const expectedMore = Math.max(0, goldCandidates.length - MAX_LISTED);
  const moreMatch = /另有\s*(\d+)\s*个/.exec(text);
  const reportedMore = moreMatch ? Number(moreMatch[1]) : null;
  const moreOk = expectedMore > 0 ? reportedMore === expectedMore : reportedMore === null;

  checks.push({
    area,
    name: `${docPrefix}构建候选：超出上限的候选构建计数与独立依据一致`,
    expected: expectedMore > 0 ? `另有 ${expectedMore} 个` : '没有“另有”计数',
    actual: reportedMore !== null
      ? `另有 ${reportedMore} 个`
      : (expectedMore > 0 ? '未报告“另有”计数' : '没有“另有”计数'),
    ok: moreOk,
  });

  for (const alias of expectedListed.filter((c) => c.name !== c.base)) {
    const item = reported.find((r) => r.name === alias.name);
    const aliasOk = item !== undefined && (item.base === alias.base || item.raw.includes(alias.base));
    checks.push({
      area,
      name: `${docPrefix}候选别名 ${alias.name} 带出依据的构建 ${alias.base}`,
      expected: `注明依据构建 ${alias.base}`,
      actual: aliasOk ? `已带出依据构建 ${alias.base}` : (item ? `未注明依据构建（实际：${item.raw}）` : '未列出该候选'),
      ok: aliasOk,
    });
  }

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
      name: `${docPrefix}候选 ${gold.name} 的制作时间与基础构建与独立依据一致`,
      expected: expected.join('；'),
      actual: ok ? actual.join('；') : item === undefined ? '未列出该候选' : `不一致（${actual.join('；')}）`,
      ok,
    });
  }

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
      name: `${docPrefix}写出的构建名 ${w.name} 分类与独立依据一致（${w.classification}）`,
      expected: `分类为 ${w.classification}${w.line ? ` (${w.line})` : ''}`,
      actual: actualDesc,
      ok: match,
    });
  }

  return checks;
}

export default function scenario(gold: LocationGold): Scenario {
  const area = '用例定位';
  const pack = 'case-location';
  const pagerState = createPagerState();

  const isList = 'documents' in gold && Array.isArray(gold.documents);
  const docs: DocumentLocationGold[] = isList
    ? (gold as LocationListGold).documents
    : [gold as DocumentLocationGold];

  const defaultProduct = (isList ? (gold as LocationListGold).product : (gold as DocumentLocationGold).product) ?? 'apv';

  const prompt = isList
    ? `请对敏捷平台上的测试脑图 ${docs.map((d) => d.document).join('、')} 做用例定位。`
    : `请对敏捷平台上的测试脑图 ${docs[0].document} 做用例定位。`;

  return {
    name: 'case-location',
    area,
    prompt,
    respond: (turn) =>
      pagedRespond(
        turn,
        pagerState,
        () => [
          {
            tool: 'hub_start_run',
            input: {
              pack,
              product: defaultProduct,
              inputs: {
                documents: isList
                  ? docs.map((d) => ({ external: `agile:mindmap:${d.document}` }))
                  : { external: `agile:mindmap:${docs[0].document}` },
              },
            },
          },
        ],
        '定位完成。',
      ),
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const has = (needle: string): boolean => text.includes(needle);

      const checks: Check[] = [
        {
          area,
          name: '模型拿到了运行结果，不是错误',
          expected: '回答里有“运行 run_…”，没有“出错”',
          actual: has('运行 run_') && !has('出错：') ? '有运行结果' : text.slice(0, 120),
          ok: has('运行 run_') && !has('出错：'),
        },
      ];

      if (isList) {
        const distinctLines = new Set(docs.map((d) => d.line));
        const distinctModules = new Set(docs.map((d) => d.module).filter(Boolean));
        const isSufficient = docs.length >= 5 && distinctLines.size >= 2 && distinctModules.size >= 2;
        checks.push({
          area,
          name: '文档清单至少 5 份（覆盖不同版本线与模块）',
          expected: '至少 5 份文档，至少 2 条版本线，至少 2 个模块',
          actual: `共 ${docs.length} 份文档，${distinctLines.size} 条版本线，${distinctModules.size} 个模块`,
          ok: isSufficient,
        });

        const expectedSatisfy = `location 用例定位：满足 ${docs.length}`;
        const hasSatisfy = has(expectedSatisfy) || has('location 用例定位：满足');
        checks.push({
          area,
          name: '要求项 location 满足',
          expected: expectedSatisfy,
          actual: hasSatisfy ? expectedSatisfy : '未满足',
          ok: hasSatisfy,
        });

        // Per-document checks
        for (const doc of docs) {
          const docPrefix = `文档 ${doc.document}：`;

          // Find document line or item snippet
          const docRegex = new RegExp(`(?:^|\\n)[\\s\\-]*${doc.document}\\s*\\|[^\n]*`, 'u');
          const docMatch = docRegex.exec(text);
          const docText = docMatch ? docMatch[0] : text;

          // Line
          const lineExpected = `版本 ${doc.line}（目录，置信度高）`;
          const lineOk = docText.includes(lineExpected) || has(`文档 ${doc.document}[^\\n]*${doc.line}`) || (has(lineExpected) && docs.length === 1);
          checks.push({
            area,
            name: `${docPrefix}版本线与独立依据一致`,
            expected: lineExpected,
            actual: lineOk ? '一致' : '不一致',
            ok: lineOk,
          });

          // Train
          if (doc.train !== undefined) {
            const trainExpected = `发布火车 ${doc.train}`;
            const trainOk = docText.includes(trainExpected) || has(`文档 ${doc.document}[^\\n]*${doc.train}`) || (has(trainExpected) && docs.length === 1);
            checks.push({
              area,
              name: `${docPrefix}发布火车与独立依据一致`,
              expected: trainExpected,
              actual: trainOk ? '一致' : '不一致',
              ok: trainOk,
            });
          }

          // Module
          if (doc.module !== undefined) {
            const moduleExpected = `模块 ${doc.module}`;
            const moduleOk = docText.includes(moduleExpected) || has(`文档 ${doc.document}[^\\n]*${doc.module}`) || (has(moduleExpected) && docs.length === 1);
            checks.push({
              area,
              name: `${docPrefix}模块与独立依据一致`,
              expected: moduleExpected,
              actual: moduleOk ? '一致' : '不一致',
              ok: moduleOk,
            });
          }

          // Stories
          if (doc.stories !== undefined && doc.stories.length > 0) {
            for (const storyId of doc.stories) {
              const storyExpected = `需求 ${storyId}`;
              const storyOk = docText.includes(storyExpected) || has(storyExpected);
              checks.push({
                area,
                name: `${docPrefix}关联需求 ${storyId} 与独立依据一致`,
                expected: storyExpected,
                actual: storyOk ? '一致' : '不一致',
                ok: storyOk,
              });
            }
          }

          // Bugs
          if (doc.bugs !== undefined && doc.bugs.length > 0) {
            for (const bugId of doc.bugs) {
              const bugExpected = `缺陷 ${bugId}`;
              const bugOk = docText.includes(bugExpected) || has(bugExpected);
              checks.push({
                area,
                name: `${docPrefix}关联缺陷 ${bugId} 与独立依据一致`,
                expected: bugExpected,
                actual: bugOk ? '一致' : '不一致',
                ok: bugOk,
              });
            }
          }

          // PLM verification checks
          if (doc.plmFound !== undefined) {
            for (const [id, found] of Object.entries(doc.plmFound)) {
              checks.push({
                area,
                name: `${docPrefix}关联编号 ${id} 在缺陷系统里${found ? '找到' : '未找到'}`,
                expected: found ? '在缺陷系统里找到' : '在缺陷系统里未找到',
                actual: found ? '在缺陷系统里找到' : '在缺陷系统里未找到',
                ok: true,
              });
            }
          }

          // Candidates for this doc if provided
          if (doc.buildCandidates !== undefined) {
            checks.push(...checkCandidateBuilds(area, text, doc.buildCandidates, doc.writtenBuilds, docPrefix));
          }
        }
      } else {
        // Single document backward-compatible checks
        const singleDoc = docs[0];
        checks.push(
          { area, name: '要求项 location 满足', expected: 'location 用例定位：满足 1', actual: has('location 用例定位：满足 1') ? '满足 1' : '未满足', ok: has('location 用例定位：满足 1') },
          { area, name: '版本线与独立依据一致', expected: `版本 ${singleDoc.line}（目录，置信度高）`, actual: has(`版本 ${singleDoc.line}（目录，置信度高）`) ? '一致' : '不一致', ok: has(`版本 ${singleDoc.line}（目录，置信度高）`) },
          { area, name: '产品线', expected: '产品线 apv', actual: has('产品线 apv') ? '一致' : '不一致', ok: has('产品线 apv') },
        );
        if (singleDoc.train !== undefined) {
          checks.splice(3, 0, { area, name: '发布火车与独立依据一致', expected: `发布火车 ${singleDoc.train}`, actual: has(`发布火车 ${singleDoc.train}`) ? '一致' : '不一致', ok: has(`发布火车 ${singleDoc.train}`) });
        }
        if (singleDoc.buildCandidates !== undefined) {
          checks.push(...checkCandidateBuilds(area, text, singleDoc.buildCandidates, singleDoc.writtenBuilds));
        }
      }

      checks.push({
        area,
        name: '回答没有超过客户端能转交的长度',
        expected: '每个工具结果不超过 30000 个字符',
        actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`,
        ok: resultTexts(turns).every((t) => t.length <= 30_000),
      });

      return checks;
    },
  };
}
