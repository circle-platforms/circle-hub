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

const GLOBAL_SCOPE_HEADING = /^(?:全局|通用|整体|测试范围|使用者原话)/;
const USER_RULING_LINE = /^\s*(?:[-*+]\s+)?(使用者决定：.+)$/;

/** Classifies a Markdown heading in `scope.md` as global or scoped to specific case identifiers. */
export function classifyScopeHeading(
  headingText: string,
  caseIds: ReadonlySet<string>,
): { isGlobal: boolean; caseTokens: string[]; isCaseHeader: boolean } {
  const trimmed = headingText.trim();
  const isGlobal = GLOBAL_SCOPE_HEADING.test(trimmed);
  if (isGlobal) return { isGlobal: true, caseTokens: [], isCaseHeader: false };
  const detected = detectCaseHeadingMarkers(trimmed);
  const directMatches = [...caseIds].filter(
    (id) =>
      id.length >= 2 &&
      new RegExp(`(?:^|[\\s（(\\[：:、/])${escapeRegExp(id)}(?:$|[\\s）)\\]：:、/])`).test(trimmed),
  );
  const caseTokens = [...new Set([...detected, ...directMatches])];
  return { isGlobal: false, caseTokens, isCaseHeader: caseTokens.length > 0 };
}

/** Extracts verbatim `使用者决定：...` lines applicable to `caseIds` (global sections or matching per-case headings). */
export function extractScopeUserRulings(
  scopeText: string,
  caseIds: ReadonlySet<string>,
  fallbackTarget: string,
): Array<{ target: string; ruling: string }> {
  const lines = scopeText.replace(/\r\n/g, '\n').split('\n');
  let activeDepth = 0;
  let activeCaseTokens: string[] | null = null;
  const seen = new Set<string>();
  const rulings: Array<{ target: string; ruling: string }> = [];

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const { caseTokens, isCaseHeader } = classifyScopeHeading(heading[2], caseIds);
      if (activeCaseTokens !== null && depth > activeDepth && !isCaseHeader) continue;
      activeDepth = depth;
      activeCaseTokens = isCaseHeader ? caseTokens : null;
      continue;
    }

    if (activeCaseTokens !== null && !activeCaseTokens.some((tok) => caseIds.has(tok))) continue;
    const match = USER_RULING_LINE.exec(line);
    if (!match) continue;
    const ruling = match[1].trimEnd();
    if (seen.has(ruling)) continue;
    seen.add(ruling);
    const target = activeCaseTokens?.find((tok) => caseIds.has(tok)) ?? fallbackTarget;
    rulings.push({ target, ruling });
  }
  return rulings;
}
