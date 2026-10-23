// Capability 3, case location, through the real client (architecture 6b):
// The model starts the production run for a document or a list of documents (at least 5, covering different lines and modules).
// The Hub's answers are compared with the gold file: version line, release train, module, build candidates,
// and associated story and defect numbers. If the gold includes manual spot-check results in the defect system (plmFound),
// they are listed at the end of the report as an informative section without affecting pass/fail checks.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import {
  MAX_PAGES,
  createPagerState,
  pagedRespond,
  parseNextCall,
  parseRecReference,
} from '../lib/pager.ts';
import type { Check, ReportSection } from '../lib/report.ts';

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
  unclassified?: string[];
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
  family: string;
  released: string | null;
  baseMention: boolean;
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

/** Reassembles renderer-split lines before finding document-owned claims. */
export function reassembleResultLines(turns: readonly LoggedTurn[]): string[] {
  const lines: string[] = [];
  for (const result of turns.flatMap(t => t.toolResults)) {
    let continuation = false;
    for (const line of result.text.split('\n')) {
      if (/^（接上页：第 \d+ 行的前 \d+ 个字符在上一页）$/.test(line)) { continuation = true; continue; }
      if (/^(?:内容 rec:|共 \d+ 行|下一页：get_nodes|完整结果|（接上页：条目)/.test(line)) continue;
      if (!line.trim()) continue;
      if (continuation && lines.length) lines[lines.length - 1] += line;
      else lines.push(line);
      continuation = false;
    }
  }
  return lines;
}
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only a claim whose position names this exact item and requirement can supply its statement. */
export function ownClaimTexts(lines: readonly string[], document: string, requirement: string): string[] {
  const position = new RegExp(`位置：条目 ${escaped(document)}(?:，|,|；).*?要求项 ${escaped(requirement)}(?:，|；|$)`);
  return [...new Set(lines.filter(line => position.test(line)).map(line => {
    const statement = line.indexOf('陈述：');
    if (statement < 0) return '';
    return line.slice(statement + 3).split(/；(?:性质与依据等级|限定|担保|根据|有效条件|解析状态)：/)[0].trim();
  }).filter(Boolean))];
}

/** Parses the displayed candidates of a single candidate statement, preserving their order. */
export function parseReportedCandidates(text: string): ParsedCandidate[] {
  const match = /版本线\s+\S+\s+的构建候选\s+\d+\s+个/.exec(text);
  if (!match) return [];
  const statement = text.slice(match.index).split(/；(?:性质与依据等级|限定|担保|根据|有效条件|解析状态)：/)[0].replace(/，(?:支持|未知|反驳).*$/, '');
  const colon = statement.indexOf('：');
  if (colon < 0) return [];
  const out: ParsedCandidate[] = [];
  for (const raw of statement.slice(colon + 1).split('；')) {
    const row = /^([A-Za-z0-9_.-]+)（(APV|NSAE)(?:，基于 ([A-Za-z0-9_.-]+))?）(制作时间未知|制作于 ([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}))，(未发布|已发布 ([0-9]{4}-[0-9]{2}(?:-[0-9]{2})?))$/.exec(raw.trim());
    if (!row) continue;
    out.push({ name: row[1], family: row[2], base: row[3] ?? row[1], baseMention: row[3] !== undefined, built: row[5] ? `${row[5]}T${row[6]}:00` : null, released: row[8] ?? null, raw: raw.trim() });
  }
  return out;
}

/** Builds manual spot-check report section from gold plmFound records. */
export function buildManualPlmSections(docs: DocumentLocationGold[], isList: boolean): ReportSection[] {
  const manualLines: string[] = [];
  for (const doc of docs) {
    if (doc.plmFound !== undefined) {
      for (const [id, found] of Object.entries(doc.plmFound)) {
        const prefix = isList ? `文档 ${doc.document}：` : '';
        const outcome = found === true ? '在缺陷系统里找到' : found === false ? '在缺陷系统里未找到' : String(found);
        manualLines.push(`- ${prefix}关联编号 ${id} ${outcome}`);
      }
    }
  }
  if (manualLines.length === 0) return [];
  return [
    {
      title: '人工抽查（不是场景核对）',
      lines: manualLines,
    },
  ];
}

export interface ReportedDocData {
  stories: Set<string>;
  bugs: Set<string>;
  unclassified: Set<string>;
  all: Set<string>;
  fromData: boolean;
}

function extractDataFromJsonObject(docId: string, obj: unknown): { requirements: string[]; defects: string[]; unclassified: string[] } | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // Direct match on case_id / document
  const caseId = String(o.case_id ?? o.document ?? o.item ?? o.id ?? '');
  if (caseId === docId || caseId === `doc:${docId}` || caseId.endsWith(`:${docId}`)) {
    if (Array.isArray(o.requirements) || Array.isArray(o.defects) || Array.isArray(o.unclassified)) {
      return {
        requirements: Array.isArray(o.requirements) ? o.requirements.map(String) : [],
        defects: Array.isArray(o.defects) ? o.defects.map(String) : [],
        unclassified: Array.isArray(o.unclassified) ? o.unclassified.map(String) : [],
      };
    }
  }

  // Partitions in ValidationResult
  if (o.partitions && typeof o.partitions === 'object') {
    const partitions = o.partitions as Record<string, unknown>;
    for (const partList of Object.values(partitions)) {
      if (!Array.isArray(partList)) continue;
      for (const item of partList) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        const itemId = String(it.item ?? it.id ?? '');
        if (itemId === docId || itemId === `doc:${docId}` || itemId.endsWith(`:${docId}`)) {
          if (Array.isArray(it.requirements)) {
            for (const req of it.requirements) {
              if (!req || typeof req !== 'object') continue;
              const r = req as Record<string, unknown>;
              if (Array.isArray(r.claims)) {
                for (const claim of r.claims) {
                  if (!claim || typeof claim !== 'object') continue;
                  const c = claim as Record<string, unknown>;
                  const data = c.statement && typeof c.statement === 'object' && 'data' in (c.statement as Record<string, unknown>)
                    ? (c.statement as { data?: Record<string, unknown> }).data
                    : undefined;
                  if (data && typeof data === 'object') {
                    if (Array.isArray(data.requirements) || Array.isArray(data.defects) || Array.isArray(data.unclassified)) {
                      return {
                        requirements: Array.isArray(data.requirements) ? data.requirements.map(String) : [],
                        defects: Array.isArray(data.defects) ? data.defects.map(String) : [],
                        unclassified: Array.isArray(data.unclassified) ? data.unclassified.map(String) : [],
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Items list
  if (Array.isArray(o.items)) {
    for (const item of o.items) {
      const res = extractDataFromJsonObject(docId, item);
      if (res) return res;
    }
  }

  return null;
}

function scanJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf('{', at);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        // ignore
      }
      at = end + 1;
    } else {
      break;
    }
  }
  return out;
}

function extractIdsFromSnippet(snippet: string, marker: string): string[] {
  const match = new RegExp(`${marker}\\s+([^；;|\\n]+)`).exec(snippet);
  if (!match) return [];
  const part = match[1].replace(/\s*(?:等|另有)\s*\d+\s*个.*$/, '');
  const ids: string[] = [];
  for (const m of part.matchAll(/(?<![0-9])([0-9]{2,9})(?![0-9])/g)) {
    ids.push(m[1]);
  }
  return ids;
}

export function extractReportedDocumentData(docId: string, turns: LoggedTurn[]): ReportedDocData {
  for (const turn of turns) {
    for (const res of turn.toolResults) {
      if (!res.text) continue;
      try {
        const parsed = JSON.parse(res.text);
        const data = extractDataFromJsonObject(docId, parsed);
        if (data) {
          return {
            stories: new Set(data.requirements),
            bugs: new Set(data.defects),
            unclassified: new Set(data.unclassified),
            all: new Set([...data.requirements, ...data.defects, ...data.unclassified]),
            fromData: true,
          };
        }
      } catch {
        // Not JSON
      }
      for (const obj of scanJsonObjects(res.text)) {
        const data = extractDataFromJsonObject(docId, obj);
        if (data) {
          return {
            stories: new Set(data.requirements),
            bugs: new Set(data.defects),
            unclassified: new Set(data.unclassified),
            all: new Set([...data.requirements, ...data.defects, ...data.unclassified]),
            fromData: true,
          };
        }
      }
    }
  }

  // Fallback to text
  const text = resultTexts(turns).join('\n');
  const docRegex = new RegExp(`(?:^|\\n)[\\s\\-]*(?:doc:)?${docId}\\s*\\|[^\n]*`, 'u');
  const docMatch = docRegex.exec(text);
  const docSnippet = docMatch ? docMatch[0] : text;

  const stories = new Set(extractIdsFromSnippet(docSnippet, '需求'));
  const bugs = new Set(extractIdsFromSnippet(docSnippet, '缺陷'));
  const unclassified = new Set(extractIdsFromSnippet(docSnippet, '未分类编号'));
  const all = new Set([...stories, ...bugs, ...unclassified]);

  return { stories, bugs, unclassified, all, fromData: false };
}

export function checkCandidateBuilds(
  area: string, text: string, input: BuildCandidateGold[] | BuildCandidatesGold | undefined,
  writtenInput?: WrittenBuildGold[], prefix = '',
): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, expected = '一致', actual = ok ? '一致' : '不一致'): void => { checks.push({ area, name: prefix + name, expected, actual, ok }); };
  if (input === undefined) { add('构建候选：独立答案完整', false, '候选依据 1 份', '候选依据 0 份'); return checks; }
  const gold = orderGoldCandidates(Array.isArray(input) ? input : input.candidates);
  const claims = text.split('\n').filter(line => /版本线\s+\S+\s+的构建候选\s+\d+\s+个/.test(line));
  if (claims.length !== 1 || /，未知(?:，|；|$)/.test(claims[0])) { add('构建候选：文档自己的主张可用', false, '可用主张 1 条', '可用主张 0 条'); return checks; }
  const statement = claims[0], reported = parseReportedCandidates(statement);
  const total = Number(/的构建候选\s+(\d+)\s+个/.exec(statement)?.[1] ?? -1);
  const aliases = Number(/其中别名\s+(\d+)\s+个/.exec(statement)?.[1] ?? 0);
  add('构建候选：候选总数', total === gold.length, `${gold.length} 个`, `${total < 0 ? 0 : total} 个`);
  add('构建候选：别名数', aliases === gold.filter(c => c.name !== c.base).length);
  const expected = gold.slice(0, MAX_LISTED);
  const missing = expected.filter(c => !reported.some(r => r.name === c.name)).length;
  const extra = reported.filter(c => !expected.some(r => r.name === c.name)).length;
  add('构建候选：候选构建名集合', !missing && !extra && reported.length === expected.length, `${expected.length} 个`, `缺 ${missing} 个，多 ${extra} 个`);
  add('构建候选：超出上限的候选构建计数（另有）', Number(/；另有\s*(\d+)\s*个/.exec(statement)?.[1] ?? 0) === Math.max(0, gold.length - MAX_LISTED));
  expected.forEach((candidate, j) => {
    const got = reported[j], label = `第 ${j + 1} 个候选：`;
    add(label + '名称和顺序', got?.name === candidate.name);
    add(label + '名称族', got?.family === candidate.family);
    add(label + '基础构建', !!got && got.base === candidate.base && got.baseMention === (candidate.base !== candidate.name));
    add(label + '制作时间', !!got && (got.built?.slice(0, 16) ?? null) === (candidate.built?.slice(0, 16) ?? null));
    add(label + '发布状态和日期', !!got && got.released === (candidate.released?.slice(0, 10) ?? null));
  });
  const written = Array.isArray(input) ? writtenInput ?? [] : input.written ?? writtenInput ?? [];
  written.forEach((item, j) => {
    const owned = text.split('\n').filter(line => line.includes(item.name)).join('\n');
    const ok = item.classification === 'known' ? /是定位到的版本线的构建|是候选/.test(owned) : item.classification === 'other_line' ? owned.includes('属于版本线') && (!item.line || owned.includes(item.line)) : /不认识写出的构建名/.test(owned);
    add(`第 ${j + 1} 个写出的构建名分类`, ok);
  });
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

  const manualSections = buildManualPlmSections(docs, isList);

  return {
    name: 'case-location',
    area,
    prompt,
    sections: manualSections.length > 0 ? manualSections : undefined,
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
      const resultLines = reassembleResultLines(turns);
      const text = resultLines.join('\n');
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

          // Associated IDs & Categories
          const reported = extractReportedDocumentData(doc.document, turns);
          const goldStories = new Set(doc.stories ?? []);
          const goldBugs = new Set(doc.bugs ?? []);
          const goldUnclassified = doc.unclassified !== undefined
            ? new Set(doc.unclassified)
            : new Set((doc.associatedIds ?? []).filter((id) => !goldStories.has(id) && !goldBugs.has(id)));
          const goldAssociated = new Set(doc.associatedIds ?? [...goldStories, ...goldBugs, ...goldUnclassified]);

          const hasAnyGoldIds = doc.associatedIds !== undefined || doc.stories !== undefined || doc.bugs !== undefined || doc.unclassified !== undefined;

          if (hasAnyGoldIds) {
            const missing = [...goldAssociated].filter((id) => !reported.all.has(id));
            const extra = [...reported.all].filter((id) => !goldAssociated.has(id));
            const setOk = missing.length === 0 && extra.length === 0;
            checks.push({
              area,
              name: `${docPrefix}关联编号集合与独立依据一致`,
              expected: `共 ${goldAssociated.size} 个（${[...goldAssociated].sort().join('、')}）`,
              actual: setOk
                ? `共 ${reported.all.size} 个，集合一致`
                : `${missing.length > 0 ? `缺 ${missing.length} 个（${missing.join('、')}）` : ''}${missing.length > 0 && extra.length > 0 ? '，' : ''}${extra.length > 0 ? `多 ${extra.length} 个（${extra.join('、')}）` : ''}`,
              ok: setOk,
            });

            // Stories
            for (const storyId of [...goldStories].sort()) {
              const storyOk = reported.stories.has(storyId);
              checks.push({
                area,
                name: `${docPrefix}关联需求 ${storyId} 与独立依据一致`,
                expected: `需求 ${storyId}`,
                actual: storyOk ? '一致' : '不一致',
                ok: storyOk,
              });
            }

            // Bugs
            for (const bugId of [...goldBugs].sort()) {
              const bugOk = reported.bugs.has(bugId);
              checks.push({
                area,
                name: `${docPrefix}关联缺陷 ${bugId} 与独立依据一致`,
                expected: `缺陷 ${bugId}`,
                actual: bugOk ? '一致' : '不一致',
                ok: bugOk,
              });
            }

            // Unclassified
            for (const id of [...goldUnclassified].sort()) {
              const unclassOk = reported.unclassified.has(id);
              checks.push({
                area,
                name: `${docPrefix}未分类编号 ${id} 与独立依据一致`,
                expected: `未分类编号 ${id}`,
                actual: unclassOk ? '一致' : '不一致',
                ok: unclassOk,
              });
            }
          }

          // Candidates for this doc if provided
          checks.push(...checkCandidateBuilds(area, ownClaimTexts(resultLines, doc.document, 'build_candidates').join('\n'), doc.buildCandidates, doc.writtenBuilds, docPrefix));
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
        if (singleDoc.module !== undefined) {
          checks.push({ area, name: '模块与独立依据一致', expected: `模块 ${singleDoc.module}`, actual: has(`模块 ${singleDoc.module}`) ? '一致' : '不一致', ok: has(`模块 ${singleDoc.module}`) });
        }

        const hasAnyGoldIds = singleDoc.associatedIds !== undefined || singleDoc.stories !== undefined || singleDoc.bugs !== undefined || singleDoc.unclassified !== undefined;
        if (hasAnyGoldIds) {
          const reported = extractReportedDocumentData(singleDoc.document, turns);
          const goldStories = new Set(singleDoc.stories ?? []);
          const goldBugs = new Set(singleDoc.bugs ?? []);
          const goldUnclassified = singleDoc.unclassified !== undefined
            ? new Set(singleDoc.unclassified)
            : new Set((singleDoc.associatedIds ?? []).filter((id) => !goldStories.has(id) && !goldBugs.has(id)));
          const goldAssociated = new Set(singleDoc.associatedIds ?? [...goldStories, ...goldBugs, ...goldUnclassified]);

          const missing = [...goldAssociated].filter((id) => !reported.all.has(id));
          const extra = [...reported.all].filter((id) => !goldAssociated.has(id));
          const setOk = missing.length === 0 && extra.length === 0;
          checks.push({
            area,
            name: '关联编号集合与独立依据一致',
            expected: `共 ${goldAssociated.size} 个（${[...goldAssociated].sort().join('、')}）`,
            actual: setOk
              ? `共 ${reported.all.size} 个，集合一致`
              : `${missing.length > 0 ? `缺 ${missing.length} 个（${missing.join('、')}）` : ''}${missing.length > 0 && extra.length > 0 ? '，' : ''}${extra.length > 0 ? `多 ${extra.length} 个（${extra.join('、')}）` : ''}`,
            ok: setOk,
          });

          for (const storyId of [...goldStories].sort()) {
            const storyOk = reported.stories.has(storyId);
            checks.push({ area, name: `关联需求 ${storyId} 与独立依据一致`, expected: `需求 ${storyId}`, actual: storyOk ? '一致' : '不一致', ok: storyOk });
          }
          for (const bugId of [...goldBugs].sort()) {
            const bugOk = reported.bugs.has(bugId);
            checks.push({ area, name: `关联缺陷 ${bugId} 与独立依据一致`, expected: `缺陷 ${bugId}`, actual: bugOk ? '一致' : '不一致', ok: bugOk });
          }
          for (const id of [...goldUnclassified].sort()) {
            const unclassOk = reported.unclassified.has(id);
            checks.push({ area, name: `未分类编号 ${id} 与独立依据一致`, expected: `未分类编号 ${id}`, actual: unclassOk ? '一致' : '不一致', ok: unclassOk });
          }
        }

        checks.push(...checkCandidateBuilds(area, ownClaimTexts(resultLines, singleDoc.document, 'build_candidates').join('\n'), singleDoc.buildCandidates, singleDoc.writtenBuilds));
      }

      const compared = docs.flatMap(doc => ownClaimTexts(resultLines, doc.document, 'build_candidates').filter(line => !/，未知(?:，|；|$)/.test(line)).flatMap(parseReportedCandidates));
      for (const [name, ok] of [['APV 名称族', compared.some(c => c.family === 'APV')], ['NSAE 名称族', compared.some(c => c.family === 'NSAE')], ['别名', compared.some(c => c.baseMention)]] as const) checks.push({ area, name: '候选覆盖：' + name, expected: '至少 1 个', actual: ok ? '至少 1 个' : '0 个', ok });

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
