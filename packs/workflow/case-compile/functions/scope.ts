export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectCaseHeadingMarkers(headingText: string): string[] {
  const markers: string[] = [];
  const autoidMatches = headingText.match(/(?:^|[^\d])(\d{10,})(?=[^\d]|$)/g) ?? [];
  for (const m of autoidMatches) {
    const digits = /\d{10,}/.exec(m);
    if (digits) markers.push(digits[0]);
  }
  const docMatches = headingText.match(/\bdoc-\d+:c-\d+\b/g) ?? [];
  markers.push(...docMatches);
  const itemMatches = headingText.match(/\bitem_[A-Za-z0-9_-]+\b/g) ?? [];
  markers.push(...itemMatches);
  const casePrefix = /\bcase[:_-]([A-Za-z0-9_-]+)\b/i.exec(headingText);
  if (casePrefix) markers.push(casePrefix[1]);
  const explicitZh = /^(?:用例|条目)\s+([A-Za-z0-9_-]{2,})\b/.exec(headingText.trim());
  if (explicitZh) markers.push(explicitZh[1]);
  const bareIdx = /^(\d{1,3})(?=$|[\s（(\[：:、-])/.exec(headingText.trim());
  if (bareIdx) markers.push(bareIdx[1]);
  return [...new Set(markers)];
}

export interface ScopeSelection {
  inScope: string[];
  outOfScope: string[];
}

const EXCLUDED_SECTION_HEADING = /^(?:范围外|不纳入|排除|不做|暂不做|不测|其他(?:用例)?(?:说明|疑问|待确认))/;
const GLOBAL_HEADING = /^(?:全局|通用|整体|测试范围|交付范围|范围|本次(?:脚本编写)?范围|使用者原话)/;
const PARENTHETICAL_NOTE = /^\s*[（(][^）)]*(?:询问|问过|答复|主代理|不纳入|排除|暂不做|不做|跳过)[^）)]*[）)]\s*[。.]?\s*$/;
const EXCLUSION_DIRECTIVE = /^\s*(?:[-*]\s*|\*\*)?(?:排除|不做|暂不做|不测|未纳入|跳过|范围外)\s*[：:]/;
const SCOPE_DIRECTIVE = /^\s*(?:[-*]\s*|\*\*|#{1,6}\s+)?(?:纳入(?:的)?用例|本次(?:编译|交付|脚本编写)?范围|测试范围|交付范围|范围|scope)\s*[：:]\s*(.+)$/i;
const ONLY_DO_CLAUSE = /(?:本次|此次)?(?:只做|仅做|只测|仅测|只编|仅编|只纳入|仅纳入)\s*[：:]?\s*([^。；\n]+)/g;
const NEGATIVE_TAIL = /[，,；;]?\s*(?:不做|不测|暂不做|排除|跳过|未纳入|其他(?:不|暂)).*$/;
const NEGATIVE_SPAN = /(?:不做|不测|暂不做|排除|跳过|未纳入)[^，,。；\n]*/g;
const INLINE_QA = /[（(][^）)]*(?:询问|问过|答复|主代理)[^）)]*[）)]/g;
const EXPLICIT_CASE_TOKEN = /(?:^|[^\dA-Za-z_-])(\d{10,}|doc-\d+:c-\d+|item_[A-Za-z0-9_-]+)(?=$|[^\dA-Za-z_-])/g;

function extractTokens(segment: string, population: readonly string[], knownSet: ReadonlySet<string>): { known: Set<string>; unknown: string[] } {
  const known = new Set<string>();
  const byLength = [...population].sort((a, b) => b.length - a.length);
  for (const id of byLength) {
    const boundary = new RegExp(`(?:^|[\\s,，、;；:：()（）\\[\\]「」"'\`<>*])(${escapeRegExp(id)})(?=$|[\\s,，、;；:：()（）\\[\\]「」"'\`<>*。])`);
    if (boundary.test(segment)) known.add(id);
  }
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();
  for (const match of segment.matchAll(EXPLICIT_CASE_TOKEN)) {
    const token = match[1];
    if (!knownSet.has(token) && !seenUnknown.has(token)) {
      seenUnknown.add(token);
      unknown.push(token);
    }
  }
  return { known, unknown };
}

function finalizeSelection(
  found: { known: Set<string>; unknown: string[] },
  population: readonly string[],
  scopeLabel: string,
): ScopeSelection {
  if (found.unknown.length) {
    throw new Error(`--scope ${scopeLabel}包含不在本次清单里的原始用例：${found.unknown.join('、')}`);
  }
  const inScope = population.filter((id) => found.known.has(id));
  if (!inScope.length) {
    throw new Error(`--scope ${scopeLabel}没有选中任何原始用例`);
  }
  const inSet = new Set(inScope);
  return { inScope, outOfScope: population.filter((id) => !inSet.has(id)) };
}

/**
 * Resolves the declared in-scope subset of `population` from a `scope.md` document.
 * Ignores excluded sections, explicit exclusion directives, and parenthetical Q&A notes
 * (e.g. recording why an excluded case was left out), and checks tiers in order:
 * 1) explicit `范围：` directives, 2) per-case `## <autoid>` headings, 3) `只做`/`仅做` clauses,
 * 4) remaining plain/bullet ID lines or `全部`.
 */
export function parseScopePopulation(scopeText: string, population: readonly string[], scopeLabel = '范围文件'): ScopeSelection {
  const knownSet = new Set(population);
  const lines = scopeText.replace(/\r\n/g, '\n').split('\n');
  const activeLines: string[] = [];
  let excludedDepth: number | null = null;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const title = heading[2].trim();
      if (excludedDepth !== null && depth <= excludedDepth) excludedDepth = null;
      if (EXCLUDED_SECTION_HEADING.test(title)) {
        excludedDepth = depth;
        continue;
      }
    }
    if (excludedDepth !== null) continue;
    if (PARENTHETICAL_NOTE.test(line) || EXCLUSION_DIRECTIVE.test(line)) continue;
    activeLines.push(line);
  }

  const merge = (acc: { known: Set<string>; unknown: string[] }, next: { known: Set<string>; unknown: string[] }) => {
    for (const id of next.known) acc.known.add(id);
    for (const u of next.unknown) if (!acc.unknown.includes(u)) acc.unknown.push(u);
  };

  // Tier 1: explicit `范围：` / `纳入用例：` / `scope:` directives.
  const tier1 = { known: new Set<string>(), unknown: [] as string[] };
  let directiveAll = false;
  for (const line of activeLines) {
    const match = SCOPE_DIRECTIVE.exec(line);
    if (!match) continue;
    const rhs = match[1].replace(/^\*\*|\*\*$/g, '').trim();
    if (/^(?:全部(?:用例)?|整批|all)[。.]?$/i.test(rhs)) { directiveAll = true; continue; }
    merge(tier1, extractTokens(rhs, population, knownSet));
  }
  if (tier1.known.size || tier1.unknown.length) return finalizeSelection(tier1, population, scopeLabel);
  if (directiveAll) return { inScope: [...population], outOfScope: [] };

  // Tier 2: per-case headings (`## <autoid> ...`).
  const tier2 = { known: new Set<string>(), unknown: [] as string[] };
  for (const line of activeLines) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (!heading) continue;
    const title = heading[1].trim();
    if (GLOBAL_HEADING.test(title)) continue;
    merge(tier2, extractTokens(title, population, knownSet));
  }
  if (tier2.known.size || tier2.unknown.length) return finalizeSelection(tier2, population, scopeLabel);

  // Tier 3: `只做` / `仅做` / `只测` / `仅测` clauses.
  const tier3 = { known: new Set<string>(), unknown: [] as string[] };
  for (const rawLine of activeLines) {
    const cleaned = rawLine.replace(INLINE_QA, ' ');
    for (const match of cleaned.matchAll(ONLY_DO_CLAUSE)) {
      const clause = match[1].replace(NEGATIVE_TAIL, '');
      merge(tier3, extractTokens(clause, population, knownSet));
    }
  }
  if (tier3.known.size || tier3.unknown.length) return finalizeSelection(tier3, population, scopeLabel);

  // Tier 4: plain/bullet ID mentions in remaining active text, or `全部`.
  const fallbackText = activeLines.map((l) => l.replace(INLINE_QA, ' ').replace(NEGATIVE_SPAN, ' ')).join('\n');
  const tier4 = extractTokens(fallbackText, population, knownSet);
  if (tier4.known.size || tier4.unknown.length) return finalizeSelection(tier4, population, scopeLabel);
  if (/全部(?:用例)?|\ball\b/i.test(fallbackText)) return { inScope: [...population], outOfScope: [] };

  throw new Error(`--scope ${scopeLabel}没有写明要交付的原始用例编号（可写“范围：<编号1>, <编号2>”或“只做 <编号1> 和 <编号2>”）`);
}
