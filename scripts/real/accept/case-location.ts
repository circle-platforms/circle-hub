import { join } from 'node:path';
import { writePrivateJson } from '../gold/builds.ts';
// Capability 3, case location, through the real client (architecture 6b):
// The model starts the production run for a document or a list of documents (at least 5, covering different lines and modules).
// The Hub's answers are compared with the gold file: version line, release train, module, build candidates,
// and associated story and defect numbers. If the gold includes manual spot-check results in the defect system (plmFound),
// they are listed at the end of the report as an informative section without affecting pass/fail checks.
import { claimVerdict, resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
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
  // 判定只认结构化字段。候选名单在 statement.text 里，正则仍按原文逐项核对，不从散文“支持”二字推断。
  const prose = statedText(text);
  const match = /版本线\s+\S+\s+的构建候选\s+\d+\s+个/.exec(prose);
  if (!match) return [];
  const statement = prose.slice(match.index).split(/；(?:性质与依据等级|限定|担保|根据|有效条件|解析状态)：/)[0].replace(/，(?:支持|未知|反驳).*$/, '');
  const colon = statement.indexOf('：');
  if (colon < 0) return [];
  const out: ParsedCandidate[] = [];
  for (const raw of statement.slice(colon + 1).split('；')) {
    const row = /^([A-Za-z0-9_.-]+)（(FAMX|FAMY)(?:，基于 ([A-Za-z0-9_.-]+))?）(制作时间未知|制作于 ([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}))，(未发布|已发布 ([0-9]{4}-[0-9]{2}(?:-[0-9]{2})?))$/.exec(raw.trim());
    if (!row) continue;
    out.push({ name: row[1], family: row[2], base: row[3] ?? row[1], baseMention: row[3] !== undefined, built: row[5] ? `${row[5]}T${row[6]}:00` : null, released: row[8] ?? null, raw: raw.trim() });
  }
  return out;
}

/** Builds manual spot-check report section from gold plmFound records. */
export function buildManualPlmSections(docs: DocumentLocationGold[], _isList: boolean): ReportSection[] {
  const found = docs.flatMap(d => Object.values(d.plmFound ?? {}));
  return found.length ? [{ title: '人工抽查（不是场景核对）', lines: [`找到 ${found.filter(v => v === true).length} 个，没找到 ${found.filter(v => v === false).length} 个`] }] : [];
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

  if (o.body && typeof o.body === 'object') return extractDataFromJsonObject(docId, o.body);
  // Partitions in ValidationResult
  if (o.partitions && typeof o.partitions === 'object') {
    const partitions = o.partitions as Record<string, unknown>;
    for (const partList of Object.values(partitions)) {
      if (!Array.isArray(partList)) continue;
      for (const item of partList) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        const itemId = String(it.item ?? it.id ?? '');
        if (itemId === docId || itemId === `doc:${docId}`) {
          if (Array.isArray(it.requirements)) {
            for (const req of it.requirements) {
              if (!req || typeof req !== 'object') continue;
              const r = req as Record<string, unknown>;
              if (r.requirement === 'location' && Array.isArray(r.claims)) {
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

/** No whole-answer fallback: a missing item remains missing even if another item has identical values. */
function statedText(input: string): string {
  try {
    const row = JSON.parse(input) as { statement?: { text?: unknown } };
    if (typeof row?.statement?.text === 'string') return row.statement.text;
  } catch { /* 散文主张没有结构化 text */ }
  return input;
}

export function ownLocationText(lines: readonly string[], document: string): string | null {
  const claims = ownClaimTexts(lines, document, 'location');
  if (claims.length === 1) return statedText(claims[0]);
  if (claims.length > 1) return null;
  const pattern = new RegExp('^\\s*-?\\s*(?:doc:)?' + escaped(document) + '\\s*\\|');
  let itemTable = false; const rows: string[] = [];
  for (const line of lines) {
    if (/^条目（.*编号.*名称.*摘要/.test(line)) { itemTable = true; continue; }
    if (/^(?:问题|内容|完整结果)|^\s*·/.test(line)) itemTable = false;
    if (!itemTable || !pattern.test(line)) continue;
    const summary = line.split(' | ')[2] ?? '';
    if (/产品线|版本 |发布火车|模块 /.test(summary)) rows.push(line);
  }
  const unique = [...new Set(rows)]; return unique.length === 1 ? unique[0] : null;
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
  const docSnippet = ownLocationText(reassembleResultLines(turns), docId) ?? '';

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
  const claimVerdicts = claims.map(claimVerdict);
  if (claims.length !== 1 || claimVerdicts[0] !== 'support' && claimVerdicts[0] !== 'refute') { add('构建候选：文档自己的主张可用', false, '可用主张 1 条（结构化判定字段可读且已确定）', (claimVerdicts[0] ?? null) === null ? '主张缺少结构化判定字段；答案不完整；下一步：翻页读取本份 build_candidates 主张，仍缺则核对构建同步并重跑本份文档' : '主张判定为未知；下一步：按回执缺失事实补齐后重跑本份文档'); return checks; }
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

export default function scenario(gold: LocationGold, detailsOut?: string): Scenario {
  const area = '用例定位', pagerState = createPagerState();
  const countLines:string[]=[];
  const docs = 'documents' in gold ? gold.documents : [gold];
  const manualSections = buildManualPlmSections(docs, docs.length > 1);
  return {
    name: 'case-location', area, countLines,
    prompt: `请对敏捷平台上的测试脑图 ${docs.map(d => d.document).join('、')} 做用例定位。`,
    sections: manualSections.length ? manualSections : undefined,
    respond: turn => pagedRespond(turn, pagerState, () => [{ tool: 'hub_start_run', input: { pack: 'case-location', product: gold.product ?? 'famx', inputs: { documents: 'documents' in gold ? docs.map(d => ({ external: `agile:mindmap:${d.document}` })) : { external: `agile:mindmap:${docs[0].document}` } } } }], '定位完成。'),
    check(turns) {
      countLines.length=0;
      const lines = reassembleResultLines(turns), text = lines.join('\n');
      const checks: Check[] = [];
      const at = process.argv.indexOf('--out');
      const destination = detailsOut ?? (at >= 0 ? process.argv[at + 1] : undefined);
      const audits: Array<{ document: string; requirement: string; statement: string | null; next_action: string }> = [];
      const add = (name: string, ok: boolean, expected = '一致', actual = ok ? '一致' : '不一致'): void => { checks.push({ area, name, expected, actual, ok }); };
      add('模型拿到了运行结果，不是错误', text.includes('运行 run_') && !turns.some(t => t.toolResults.some(r => r.isError)) && !text.includes('出错：'), '可用结果 1 份', text.includes('运行 run_') ? '结果 1 份' : '结果 0 份；下一步：重跑定位运行');
      if ('documents' in gold) {
        const counts = [docs.length, new Set(docs.map(d => d.line)).size, new Set(docs.map(d => d.module).filter(Boolean)).size];
        add('文档清单覆盖', counts[0] >= 5 && counts[1] >= 2 && counts[2] >= 2, '文档至少 5，版本线至少 2，模块至少 2', `文档 ${counts[0]}，版本线 ${counts[1]}，模块 ${counts[2]}`);
      }
      docs.forEach((doc, i) => {
        const prefix = `第 ${i + 1} 份文档：`;
        const owned = ownLocationText(lines, doc.document);
        const claims = ownClaimTexts(lines, doc.document, 'location');
        const fact = claims.length === 1 && claimVerdict(claims[0])==='support';
        add(prefix + '定位结论是事实', fact, '本份支持主张 1 条', fact ? '支持主张 1 条' : '支持主张 0 条；下一步：重读本份 location 主张，按私有详情中的 Hub 原因核对产品名称和目录树输入，再单独重跑');
        audits.push({ document: doc.document, requirement: 'location', statement: claims.length === 1 ? claims[0] : null, next_action: fact ? '' : 'Hub 原因：' + (claims[0] ?? '缺本份 location 主张') + '；据此核对原件产品名称及目录树，重读完整主张或修正输入后重跑本份文档' });
        add(prefix + '定位数据可用', owned !== null, '本份数据 1 份', owned === null ? '本份数据 0 份；下一步：翻页读取本份 location 主张；仍缺则重跑本份文档' : '本份数据 1 份');
        if (owned !== null) {
          const exactField = (label: string, value: string): boolean => new RegExp('(?:^|[；|：])' + label + '\\s+' + escaped(value) + '(?=[；|]|，(?:支持|未知|反驳)|$)').test(owned);
          add(prefix + '版本线与独立依据一致', owned.includes(`版本 ${doc.line}（目录，置信度高）`));
          if (doc.train !== undefined) add(prefix + '发布火车与独立依据一致', exactField('发布火车', doc.train));
          if (doc.module !== undefined) add(prefix + '模块与独立依据一致', exactField('模块', doc.module));
          add(prefix + '产品线', owned.toLowerCase().includes(`产品线 ${(doc.product ?? gold.product ?? 'famx').toLowerCase()}`));
        }
        const reported = extractReportedDocumentData(doc.document, turns);
        const stories = new Set(doc.stories ?? []), bugs = new Set(doc.bugs ?? []);
        const unclassified = new Set(doc.unclassified ?? (doc.associatedIds ?? []).filter(id => !stories.has(id) && !bugs.has(id)));
        const all = new Set(doc.associatedIds ?? [...stories, ...bugs, ...unclassified]);
        if (doc.associatedIds !== undefined || doc.stories !== undefined || doc.bugs !== undefined || doc.unclassified !== undefined) {
          const missing = [...all].filter(id => !reported.all.has(id)).length, extra = [...reported.all].filter(id => !all.has(id)).length;
          add(prefix + '关联编号集合与独立依据一致', !missing && !extra, `共 ${all.size} 个`, `共 ${reported.all.size} 个，缺 ${missing} 个，多 ${extra} 个`);
          for (const [kind, expected, actual] of [['需求', stories, reported.stories], ['缺陷', bugs, reported.bugs], ['未分类编号', unclassified, reported.unclassified]] as const) {
            [...expected].sort().forEach((id, j) => add(`${prefix}第 ${j + 1} 个${kind}分类`, actual.has(id)));
          }
        }
        const candidateClaims=ownClaimTexts(lines,doc.document,'build_candidates');
        const candidateUnknown=candidateClaims.some(claim=>claimVerdict(claim)==='unknown');
        add(prefix+'构建候选结论已确定',candidateClaims.length>0&&!candidateUnknown&&candidateClaims.every(claim=>claimVerdict(claim)!==null),'未知 0 项',candidateUnknown?'构建候选检查仍未知；下一步按私有回执缺失事实重读或补齐后重跑':candidateClaims.length?(candidateClaims.every(claim=>claimVerdict(claim)!==null)?'确定结论':'主张缺少结构化判定字段，答案不完整；下一步翻页补读或重跑'):'缺少构建候选结论；下一步翻页补读，仍缺则重跑');
        if(candidateUnknown || !candidateClaims.length)countLines.push(`未完成核对 1 项；原因：构建候选${candidateUnknown?'仍未知':'缺结论'}；下一步按私有回执补齐事实后重读或重跑`);
        if(candidateUnknown)audits.push({document:doc.document,requirement:'build_candidates',statement:candidateClaims.join('\n'),next_action:'按本份回执的缺失事实重读或补齐，再重跑；未知不能作为通过'});
        checks.push(...checkCandidateBuilds(area, ownClaimTexts(lines, doc.document, 'build_candidates').join('\n'), doc.buildCandidates, doc.writtenBuilds, prefix));
      });
      if (destination !== undefined) { try { writePrivateJson(join(destination, 'case-location-details.json'), audits); } catch { add('定位私有明细已保存', false, '新明细文件 1 份', '明细文件 0 份；下一步：改用 Git 外新 --out 目录后重跑，不覆盖旧证据'); } }
      const compared = docs.flatMap(doc => ownClaimTexts(lines, doc.document, 'build_candidates').filter(line => { const verdict = claimVerdict(line); return verdict === 'support' || verdict === 'refute'; }).flatMap(parseReportedCandidates));
      for (const [name, ok] of [['FAMX 名称族', compared.some(c => c.family === 'FAMX')], ['FAMY 名称族', compared.some(c => c.family === 'FAMY')], ['别名', compared.some(c => c.baseMention)]] as const) add('候选覆盖：' + name, ok, '至少 1 个', ok ? '至少 1 个' : '0 个；下一步：选择前 12 项覆盖两个名称族和别名的版本线后重跑');
      const longest = Math.max(0, ...resultTexts(turns).map(t => t.length));
      add('回答没有超过客户端能转交的长度', longest <= 30_000, '不超过 30000 个字符', `最长 ${longest} 个字符`);
      return checks;
    },
  };
}
