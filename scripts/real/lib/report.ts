// A small acceptance report: each check states what was expected, what was seen and whether they agree, with the evidence
// (run ids, digests, file names) that lets someone repeat it. Rendered as Markdown for the owner; nothing here holds secrets.
export interface Check {
  /** Which capability or area, for example "用例评审" or "回归范围". */
  area: string;
  name: string;
  /** What the independent gold says. */
  expected: string;
  /** What the Hub (or the client) produced. */
  actual: string;
  ok: boolean;
  /** Run ids, digests, file names: how to look at it again. */
  evidence?: string[];
  note?: string;
}

export interface ReportSection {
  title: string;
  lines: string[];
}

export interface Report {
  title: string;
  generatedAt: string;
  checks: Check[];
  /** Things the report cannot prove, in plain words. */
  limits: string[];
  /** Additional sections rendered at the end of the report. */
  sections?: ReportSection[];
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function summary(checks: readonly Check[]): { total: number; passed: number; failed: number; byArea: Record<string, { passed: number; failed: number }> } {
  const byArea: Record<string, { passed: number; failed: number }> = {};
  for (const c of checks) {
    const a = (byArea[c.area] ??= { passed: 0, failed: 0 });
    if (c.ok) a.passed += 1;
    else a.failed += 1;
  }
  const passed = checks.filter((c) => c.ok).length;
  return { total: checks.length, passed, failed: checks.length - passed, byArea };
}

export function renderReport(report: Report): string {
  const s = summary(report.checks);
  const lines = [`# ${report.title}`, '', `生成时间：${report.generatedAt}`, '', `共 ${s.total} 项核对，${s.passed} 项相符，${s.failed} 项不符。`, ''];
  for (const area of Object.keys(s.byArea)) {
    lines.push(`## ${area}（${s.byArea[area].passed} 相符，${s.byArea[area].failed} 不符）`, '', '| 核对 | 预期（独立依据） | 实际 | 结果 | 依据 |', '| --- | --- | --- | --- | --- |');
    for (const c of report.checks.filter((x) => x.area === area)) {
      lines.push(`| ${cell(c.name)} | ${cell(c.expected)} | ${cell(c.actual)} | ${c.ok ? '相符' : '**不符**'} | ${cell((c.evidence ?? []).join('；') || (c.note ?? ''))} |`);
    }
    lines.push('');
  }
  lines.push('## 这份报告证明不了的事', '', ...(report.limits.length > 0 ? report.limits.map((l) => `- ${l}`) : ['- （未列出）']), '');
  if (report.sections && report.sections.length > 0) {
    for (const sec of report.sections) {
      lines.push(`## ${sec.title}`, '', ...sec.lines, '');
    }
  }
  return lines.join('\n');
}
