export const SCOPE_RULINGS_ORIGIN = 'scope.md';

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

export function extractScopeUserRulings(scopeText: string, caseIds: ReadonlySet<string>, fallbackTarget: string): Array<{target: string; ruling: string}> {
  const result: Array<{target: string; ruling: string}> = [];
  const seen = new Set<string>();
  let target: string | null = null;
  let fence: string | null = null;
  for (const line of scopeText.replace(/\r\n/g, '\n').split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) { if (fence === null) fence = delimiter; else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null; continue; }
    if (fence !== null) continue;
    const heading = /^#{1,6} +(.+?)\s*$/.exec(line);
    if (heading) {
      const text = heading[1];
      target = text === '全局' ? fallbackTarget : null;
      const declared = text.startsWith('用例 ') ? text.slice(3) : text;
      for (const id of caseIds) {
        if (declared === id || declared.startsWith(id + ' ') || declared.startsWith(id + '（') && declared.endsWith('）')) { target = id; break; }
      }
      continue;
    }
    if (target === null) continue;
    const marked = /^ {0,3}(?:[-*+] +)?(使用者决定：.+)$/.exec(line);
    if (!marked) continue;
    const ruling = marked[1], key = JSON.stringify([target, ruling]);
    if (!seen.has(key)) { seen.add(key); result.push({target, ruling}); }
  }
  return result;
}
