import { need } from './common.ts';
import { CREDENTIAL_SCANNER, scanWithMatches } from './credentials.ts';

export function circleRedact(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(
      /\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1$2***',
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      '***',
    );
}

function scan(value: string) {
  const result = scanWithMatches(Buffer.from(value, 'utf8'));
  need(result.complete && result.scan.inspected && !result.scan.truncated, 'credential_scan_incomplete', '输出无法完整扫描，本条不采集');
  return result;
}

export function sanitizeText(input: string, token?: string): { text: string; changed: boolean; detectors: string[] } {
  need(input.isWellFormed(), 'invalid_unicode', '输出不是完整 Unicode，本条不采集');
  const initial = scan(input);
  let value = circleRedact(token === undefined ? input : input.replaceAll(token, '%HUB_TOKEN%'));
  const middle = scan(value);
  const matches = [...new Set(middle.matches.filter(match => match.length > 0))].sort((a, b) => b.length - a.length);
  for (const match of matches) {
    need(value.includes(match), 'credential_redaction_failed', '输出含无法可靠脱敏的内容，本条不采集');
    value = value.replaceAll(match, '***');
  }
  const final = scan(value);
  need(final.scan.clean, 'credential_redaction_failed', '脱敏后仍未通过扫描，本条不采集');
  const detectors = [...new Set([...initial.scan.findings, ...middle.scan.findings].map(finding => finding.detector))].sort();
  return { text: value, changed: value !== input, detectors };
}

export { CREDENTIAL_SCANNER };
