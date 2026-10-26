// Gold script: independent answer generator for traceability matrix (architecture 6b).
// Parses the exported fixed-defects HTML original (Bugs_Fixed_with_<build>.html), test case mindmaps
// from a directory, optional document list, and PLM batch details originals, then joins them using
// cases.ts and join.ts to output the exact TraceGold format required by scripts/real/accept/traceability.ts.
// Imports nothing from hub/ or packs/.
//
// Usage:
//   node scripts/real/gold/trace.ts \
//     --fixed <Bugs_Fixed_with_<build>.html> \
//     --cases-dir <dir> \
//     [--docs <docs.json>] \
//     [--plm <plm.json>...] \
//     [--closed-statuses <statuses.json>] \
//     [--product <product>] \
//     [--build <build>] \
//     [--case-rule tagged|marked] \
//     --out <gold.json>
import { GoldRefusal } from './refusal.ts';
export { GoldRefusal };
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DefectGold, JoinCaseGold, TraceGold } from '../accept/traceability.ts';
import { locationsGold } from './locations.ts';
import { bugIdsOf, caseGold } from './cases.ts';
import { joinGold, parseClosedStatuses, type CaseInput, type DefectInput } from './join.ts';

export type BugSystem = 'plm' | 'bugzilla' | 'unknown';

export interface ParsedDefect {
  bug: string;
  system: BugSystem;
}

/**
 * Classifies the defect system proved by an href:
 * - PLM bug view query (m=bug, f=view, id=) -> plm
 * - Bugzilla show_bug.cgi?id= -> bugzilla
 * - Otherwise unknown
 */
export function systemOf(href: string): BugSystem {
  const decoded = href.replace(/&amp;/g, '&');
  if (/[?&]m=bug(?:[&#]|$)/i.test(decoded) && /[?&]f=view(?:[&#]|$)/i.test(decoded) && /[?&]id=/i.test(decoded)) {
    return 'plm';
  }
  if (/show_bug\.cgi\?id=[0-9]+/i.test(decoded)) {
    return 'bugzilla';
  }
  return 'unknown';
}

/**
 * Parses the exported fixed defects HTML original (Bugs_Fixed_with_<build>.html):
 * 1. Anchors whose text is a bug number (3 to 9 digits), classified by href.
 * 2. Bare numbers after the "======ID from PLM=======" marker line (PLM ids).
 * 3. Older layouts: table cells or lines beginning with a bug number.
 * Each bug id is taken once (first occurrence wins).
 */
export function parseFixedBugsHtml(html: string): ParsedDefect[] {
  const defects: ParsedDefect[] = [];
  const seen = new Set<string>();

  const add = (id: string, system: BugSystem): void => {
    if (seen.has(id)) return;
    seen.add(id);
    defects.push({ bug: id, system });
  };

  // 1. Anchors across the HTML:
  const anchorRegex = /<a\b([^>]*)>(.*?)<\/a>/gis;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const rawText = match[2].replace(/<[^>]+>/g, '').trim();
    const idMatch = /^#?([0-9]{3,9})$/.exec(rawText);
    if (idMatch) {
      const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
      add(idMatch[1], systemOf(href));
    }
  }

  // 2. Bare numbers after the "======ID from PLM=======" marker:
  const markerMatch = /=+\s*ID\s+from\s+PLM\s*=+/i.exec(html);
  if (markerMatch) {
    const tailHtml = html.slice(markerMatch.index + markerMatch[0].length);
    const lines = tailHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const tail = /^\s*#?([0-9]{3,9})\s*$/.exec(line);
      if (tail) {
        add(tail[1], 'plm');
      }
    }
  }

  // 3. Older shapes: lines or cells starting with bug ID or ID only
  const textWithoutTags = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|td|th|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  for (const rawLine of textWithoutTags.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idOnly = /^#?([0-9]{3,9})$/.exec(line);
    if (idOnly) {
      add(idOnly[1], 'unknown');
      continue;
    }
    const leading = /^(?:bug\s*#?\s*)?([0-9]{3,9})\s*[:：.、\-–—)]\s*(\S.*)$/i.exec(line);
    if (leading) {
      add(leading[1], 'unknown');
    }
  }

  return defects;
}

/**
 * Parses PLM batch detail files (one or more JSON contents).
 * Supports { bugs: [...] }, { data: [...] }, or plain arrays.
 */
export function parsePlmResponses(contents: string[]): Array<{ id: string | number; status?: string }> {
  const result: Array<{ id: string | number; status?: string }> = [];

  for (const text of contents) {
    if (!text.trim()) continue;
    try {
      const raw: unknown = JSON.parse(text);
      const extractItems = (obj: unknown): void => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === 'object') {
              if ('id' in item) {
                result.push(item as { id: string | number; status?: string });
              } else if ('bugs' in item || 'data' in item) {
                extractItems(item);
              }
            }
          }
        } else {
          const rec = obj as Record<string, unknown>;
          if (Array.isArray(rec.bugs)) {
            for (const item of rec.bugs) {
              if (item && typeof item === 'object' && 'id' in item) {
                result.push(item as { id: string | number; status?: string });
              }
            }
          }
          if (Array.isArray(rec.data)) {
            for (const item of rec.data) {
              if (item && typeof item === 'object' && 'id' in item) {
                result.push(item as { id: string | number; status?: string });
              }
            }
          }
        }
      };
      extractItems(raw);
    } catch {
      // Ignored malformed JSON
    }
  }

  return result;
}

/**
 * Normalizes a document identifier by removing agile:case:, agile:document: prefixes,
 * revisions, and file extensions.
 */
export function cleanDocId(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:agile:case:|agile:case_document:|agile:document:)/i, '');
  const atIdx = s.indexOf('@');
  if (atIdx >= 0) {
    s = s.slice(0, atIdx);
  }
  s = s.split('/').pop()?.replace(/\.(?:km\.)?json$/i, '') ?? s;
  return s.trim();
}

/**
 * Parses document list (either JSON array/object with sources/documents or plain text lines).
 * Document entries with agile:case: or agile:document: prefix are stripped to match directory filenames.
 */
export function parseDocumentList(raw: string): Set<string> {
  const docs = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) return docs;

  const addDoc = (val: unknown): void => {
    if (val === undefined || val === null) return;
    const cleaned = cleanDocId(String(val));
    if (cleaned) docs.add(cleaned);
  };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const inspect = (val: unknown): void => {
      if (!val) return;
      if (typeof val === 'string' || typeof val === 'number') {
        addDoc(val);
        return;
      }
      if (Array.isArray(val)) {
        for (const item of val) inspect(item);
        return;
      }
      if (typeof val === 'object') {
        const obj = val as Record<string, unknown>;
        if (Array.isArray(obj.sources)) {
          for (const s of obj.sources) {
            if (s && typeof s === 'object') {
              const src = s as Record<string, unknown>;
              if (typeof src.external === 'string') {
                addDoc(src.external);
              }
            }
          }
        }
        if (Array.isArray(obj.documents)) {
          for (const d of obj.documents) inspect(d);
        }
        if (Array.isArray(obj.case_documents)) {
          for (const d of obj.case_documents) inspect(d);
        }
        if (typeof obj.document === 'string' || typeof obj.document === 'number') {
          addDoc(obj.document);
        }
        if (typeof obj.id === 'string' || typeof obj.id === 'number') {
          addDoc(obj.id);
        }
      }
    };
    inspect(parsed);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const lineTrim = line.trim();
      if (!lineTrim || lineTrim.startsWith('#')) continue;
      addDoc(lineTrim);
    }
  }

  return docs;
}

/**
 * Listed documents that have no exported map, by every spelling the loader matches. The caller refuses when this
 * is not empty: a silently dropped document computes the gold on a subset (the 10-23 incident).
 */
export function missingMapDocuments(listed: ReadonlySet<string>, maps: ReadonlyArray<{ document: string }>): string[] {
  const loaded = new Set(maps.map((m) => m.document));
  return [...listed].filter((docId) => !loaded.has(docId) && !loaded.has(docId.replace(/^agile:case:/, '')) && !loaded.has(docId.replace(/^.*:/, '')));
}

/**
 * Loads mindmap files from casesDir, optionally filtered by allowedDocs.
 */
export function loadCaseMaps(casesDir: string, allowedDocs?: Set<string>): Array<{ document: string; map: unknown }> {
  const maps: Array<{ document: string; map: unknown }> = [];
  const entries = readdirSync(resolve(casesDir)).sort().filter((entry) => entry.endsWith('.json') && !entry.startsWith('.'));
  for (const [ordinal, entry] of entries.entries()) {
    const docId = entry.replace(/\.(?:km\.)?json$/i, '');
    if (
      allowedDocs !== undefined &&
      !allowedDocs.has(docId) &&
      !allowedDocs.has(entry) &&
      !allowedDocs.has(`agile:case:${docId}`)
    ) {
      continue;
    }
    const fullPath = resolve(casesDir, entry);
    const content = readFileSync(fullPath, 'utf8');
    try {
      maps.push({ document: docId, map: JSON.parse(content) as unknown });
    } catch {
      // Stage-named at the throw site (item 8): the ordinal only — never the path or the file's content.
      throw new GoldRefusal(`第 ${ordinal + 1} 份脑图不是 JSON：重新导出脑图`);
    }
  }
  return maps;
}

/**
 * Orders cases within a defect: document number ascending numerically,
 * then case id ascending lexicographically.
 */
export function compareCases(a: JoinCaseGold, b: JoinCaseGold): number {
  const colonA = a.id.indexOf(':');
  const colonB = b.id.indexOf(':');
  const docA = colonA >= 0 ? a.id.slice(0, colonA) : a.id;
  const nodeA = colonA >= 0 ? a.id.slice(colonA + 1) : '';
  const docB = colonB >= 0 ? b.id.slice(0, colonB) : b.id;
  const nodeB = colonB >= 0 ? b.id.slice(colonB + 1) : '';

  const numA = Number.parseInt(docA, 10);
  const numB = Number.parseInt(docB, 10);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
    return numA - numB;
  }
  if (docA !== docB) {
    return docA.localeCompare(docB);
  }
  return nodeA.localeCompare(nodeB);
}

export interface TraceGoldOptions {
  html: string;
  tree?: unknown;
  maps: Array<{ document: string; map: unknown }>;
  plm?: Array<{ id: string | number; status?: string; [key: string]: unknown }>;
  closedStatuses?: string[];
  product?: string;
  build?: string;
  caseRule?: 'tagged' | 'marked';
}

/**
 * Computes the independent traceability gold answer.
 */
export function traceGold(options: TraceGoldOptions): TraceGold {
  const parsedDefects = parseFixedBugsHtml(options.html);
  const caseRule = options.caseRule ?? 'marked';

  const locations = options.tree === undefined ? [] : locationsGold(options.tree).all ?? [];
  // One lookup table per tree (the per-case linear find made the integrator's full scan quadratic).
  const bugsByDocument = new Map<string, string[]>();
  for (const location of locations) {
    // The pack runs ids.ts PER TEXT (FAMX README 238-239: the case title and each label above it), so the gold
    // unions each label's ids; joining the texts let an id run continue into the next label's prefix code.
    const bugs = [...new Set([location.title, ...location.ancestors].flatMap((label) => bugIdsOf(label)))].sort();
    bugsByDocument.set(cleanDocId(location.document), bugs);
  }
  const caseInputs: CaseInput[] = [];
  for (const item of options.maps) {
    try {
      const goldResult = caseGold([item], { caseRule });
      for (const doc of goldResult.documents) {
        for (const c of doc.items) {
          caseInputs.push({
            document: doc.document,
            id: c.id,
            title: c.title,
            // The tree side names defects with the same marker family the map side uses (FAMX README 238-239: the
            // ids.ts bugs of the document's title and folders — 'bug to case N' included, which the case-location
            // extractor files as unmarked).
            defects: (() => {
              const treeBugs = bugsByDocument.get(cleanDocId(doc.document));
              return treeBugs === undefined ? c.defects : [...new Set([...c.defects, ...treeBugs])];
            })(),
          });
        }
      }
    } catch {
      // Mind maps with no case nodes are tolerated
    }
  }

  const defectInputs: DefectInput[] = parsedDefects.map((d) => ({
    bug: d.bug,
    status: 'fixed',
    module: '',
    system: d.system,
  }));

  const joinResult = joinGold(defectInputs, caseInputs, {
    plm: options.plm,
    closedStatuses: options.closedStatuses,
  });

  const defects: DefectGold[] = joinResult.rows.map((row) => ({
    bug: row.bug,
    status: row.status,
    ...(row.system !== undefined ? { system: row.system } : {}),
    ...(row.defect_system_status !== undefined ? { defect_system_status: row.defect_system_status } : {}),
    ...(row.defect_system_unknown_reason !== undefined ? { defect_system_unknown_reason: row.defect_system_unknown_reason } : {}),
    ...(row.closed !== undefined ? { closed: row.closed } : {}),
    cases: row.cases
      .map((c) => ({
        id: `${c.document}:${c.id}`,
        title: c.title,
      }))
      .sort(compareCases),
  }));

  return {
    product: options.product ?? 'famx',
    build: options.build ?? 'unknown-build',
    defects,
    // Closed counts exist only when PLM was read: a status that was never read is not 0 (the owner's rule), so a
    // gold made without --plm carries no closed status at all and the scenario says so.
    ...(options.plm !== undefined ? { closed_defects: joinResult.closed_defects, closed_traced: joinResult.closed_traced, closed_untraced: joinResult.closed_untraced } : {}),
    ...(joinResult.status_unknown !== undefined ? { status_unknown: joinResult.status_unknown } : {}),
  };
}

/** Reads the tree export; a stage-named refusal replaces the raw read or parse error (item 8). */
function readTree(treePath: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(treePath), 'utf8'));
  } catch {
    throw new GoldRefusal('敏捷树导出读不了或不是 JSON：重新导出敏捷树');
  }
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const fixedPath = value('fixed');
  const casesDir = value('cases-dir');
  const docsPath = value('docs');
  const treePath = value('tree');
  const closedPath = value('closed-statuses');
  const productArg = value('product');
  const buildArg = value('build');
  const caseRuleArg = value('case-rule');
  const outPath = value('out');

  const plmPaths: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--plm' && k + 1 < argv.length) {
      for (const p of argv[k + 1].split(',')) {
        if (p.trim()) plmPaths.push(p.trim());
      }
    }
  }

  if (!fixedPath || !casesDir || !outPath) {
    process.stderr.write(
      '用法：node scripts/real/gold/trace.ts --fixed <bugs_fixed.html> --cases-dir <dir> [--docs <docs.json>] [--tree <敏捷树导出>] [--plm <plm.json>...] [--closed-statuses <statuses.json>] [--product <product>] [--build <build>] [--case-rule tagged|marked] --out <gold.json>\n',
    );
    return 2;
  }

  try {
    const html = readFileSync(resolve(fixedPath), 'utf8');

    let allowedDocs: Set<string> | undefined;
    if (docsPath) {
      const rawDocs = readFileSync(resolve(docsPath), 'utf8');
      allowedDocs = parseDocumentList(rawDocs);
      if (allowedDocs.size === 0) throw new GoldRefusal('文档清单是空的：补上这个构建的文档清单');
    }

    const maps = loadCaseMaps(casesDir, allowedDocs);
    if (allowedDocs !== undefined) {
      // A listed document with no exported map is a missing input: refuse to start and say what to supply.
      const missing = missingMapDocuments(allowedDocs, maps);
      if (missing.length > 0) throw new GoldRefusal(`文档清单 ${allowedDocs.size} 份，导出的脑图缺 ${missing.length} 份：用 circle-hub original export 导出后重跑`);
    }

    let plm: Array<{ id: string | number; status?: string }> | undefined;
    if (plmPaths.length > 0) {
      const plmContents = plmPaths.map((p) => readFileSync(resolve(p), 'utf8'));
      plm = parsePlmResponses(plmContents);
    }

    let closedStatuses: string[] | undefined;
    if (closedPath) {
      const rawClosed: unknown = JSON.parse(readFileSync(resolve(closedPath), 'utf8'));
      closedStatuses = parseClosedStatuses(rawClosed);
    }

    let build = buildArg;
    if (!build) {
      const fileBase = basename(fixedPath);
      const match = /Bugs_Fixed_with_(.*?)(?:\.html)?$/i.exec(fileBase);
      if (match) build = match[1];
      else build = 'unknown-build';
    }

    const caseRule = caseRuleArg === 'tagged' ? 'tagged' : 'marked';
    const product = productArg ?? 'famx';

    const gold = traceGold({
      html,
      tree: treePath === undefined ? undefined : readTree(treePath),
      maps,
      plm,
      closedStatuses,
      product,
      build,
      caseRule,
    });

    writeFileSync(resolve(outPath), `${JSON.stringify(gold, null, 2)}\n`);
    return 0;
  } catch (error) {
    // A refusal prints its own decided line; anything else is named by stage, never by raw message (item 8).
    if (error instanceof GoldRefusal) {
      process.stderr.write(`${error.line}\n`);
      return 1;
    }
    process.stderr.write(`生成独立追溯答案失败：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/trace.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
