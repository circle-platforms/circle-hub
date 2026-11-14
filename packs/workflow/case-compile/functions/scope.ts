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
