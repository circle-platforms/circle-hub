// Independent reference and quotation oracle. No judged Hub or pack code is imported.
import { createHash } from 'node:crypto';
import { goldQuoteContains } from './quote-widths.ts';
import { VERDICT, REASON, type Verdict, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { locatedDrafts, object, requirementStatus, compareStatus } from './command-domains.ts';
const [SUPPORT, REFUTE, UNKNOWN] = VERDICT;
const reason = (s: Reason) => REASON.find(v => v === s)!;
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const quoteMatches = goldQuoteContains;
type Target = { scheme: string; digest?: string; parser?: string; segments?: string[]; range?: [number, number] };
const escape = (s: string, structural: string) => [...s].map(c => /[\p{Cc}\p{Cf}\p{Z}]/u.test(c) || structural.includes(c) || c === '%' ? encodeURIComponent(c) : c).join('');
function segments(raw: string, structural: string): string[] | null {
  try {
    const parts = raw.split('/');
    if (parts.some(p => p === '')) return null;
    const decoded = parts.map(p => decodeURIComponent(p));
    return decoded.every((p, i) => escape(p, structural) === parts[i]) ? decoded : null;
  } catch { return null; }
}
export function parseQuoteReference(reference: string): Target | null {
  if (reference.length > 8192) return null;
  const src = /^src:([a-f0-9]{64})(?:\/([a-z][a-z0-9_.-]{0,63}@[1-9]\d*)\/(.+))?$/.exec(reference);
  if (src) {
    let selector = src[3], range: [number, number] | undefined;
    if (selector) {
      const r = /:(\d+)-(\d+)$/.exec(selector);
      if (r) {
        if (!/^(0|[1-9]\d*)$/.test(r[1]) || !/^(0|[1-9]\d*)$/.test(r[2])) return null;
        range = [Number(r[1]), Number(r[2])];
        if (!range.every(Number.isSafeInteger) || range[0] >= range[1]) return null;
        selector = selector.slice(0, r.index);
      }
    }
    const parts = selector ? segments(selector, '/:') : undefined;
    return parts === null ? null : { scheme: 'src', digest: src[1], parser: src[2], segments: parts, range };
  }
  const tree = /^tree:([a-f0-9]{64})\/(.*)$/.exec(reference);
  if (tree) {
    const path = tree[2].split('@');
    if (path.length > 2 || (path.length === 2 && !/^[a-f0-9]{64}$/.test(path[1]))) return null;
    const parts = path[0] ? segments(path[0], '/@') : [];
    return parts === null ? null : { scheme: 'tree', digest: tree[1], segments: parts };
  }
  if (/^entry:[a-f0-9]{64}$/.test(reference)) return { scheme: 'entry' };
  const record = /^rec:[a-f0-9]{64}(?:#(.*))?$/.exec(reference);
  if (record) {
    if (record[1] !== undefined) {
      if (record[1] !== '' && !record[1].startsWith('/')) return null;
      try {
        for (const token of record[1].slice(1).split('/')) {
          const decoded = decodeURIComponent(token);
          if (escape(decoded, '#') !== token || /~(?![01])/.test(decoded)) return null;
        }
      } catch { return null; }
    }
    return { scheme: 'rec' };
  }
  return null;
}
export interface QuoteInputs { sources?: ReadonlyMap<string, Uint8Array>; manual?: readonly Uint8Array[]; run?: unknown; fixField?: string }
export interface QuoteFinding { verdict: Verdict; category: 'fix' | 'defect_other' | 'manual' | 'other' | 'unknown_defect_field' | 'unknown_target' | 'quote_absent'; reason?: Reason; scope: 'fragment' | 'necessary'; expectedVerbatim: boolean | null; gap?: { fact: string; action: string; owner: string } }
const unknown = (category: QuoteFinding['category'], why: Reason = reason('no_check'), scope: QuoteFinding['scope'] = 'fragment'): QuoteFinding => ({ verdict: UNKNOWN, category, reason: why, scope, expectedVerbatim: null, gap: { fact: why === 'missing_input' ? 'referenced_source_bytes_or_manual' : 'reference_parser_or_fragment_rule', action: why === 'missing_input' ? 'export_original_and_retry' : 'request_parser_rule_from_named_integrator', owner: 'Claude' } });
function sliceRange(text: string, range?: [number, number]): string | null {
  if (!range) return text;
  const bytes = Buffer.from(text);
  if (range[1] > bytes.length) return null;
  try { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(...range)); } catch { return null; }
}
function sourceText(bytes: Uint8Array, target: Target): string | null | undefined {
  let text: string;
  try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return undefined; }
  const p = target.segments ?? [];
  if (target.parser === 'json@1') {
    if (p[0] !== 'p') return null;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return null; }
    for (const raw of p.slice(1)) {
      // json@1 selectors use percent-escaped member names, not rec-reference JSON Pointer escaping.
      const token = raw;
      if (!object(value) && !Array.isArray(value)) return null;
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(token)) return null;
      if (!Object.hasOwn(value as object, token)) return null;
      value = (value as Record<string, unknown>)[token];
    }
    if (typeof value !== 'string') return undefined;
    text = value;
  } else if (target.parser === 'text@1') {
    if (p.length !== 2 || p[0] !== 'l') return null;
    const m = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(p[1]);
    if (!m) return null;
    const from = Number(m[1]), to = Number(m[2] ?? m[1]), lines = text.split(/\r\n|\r|\n/);
    if(/(?:\r\n|\r|\n)$/.test(text))lines.pop();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || (m[2] && from === to) || to > lines.length) return null;
    text = lines.slice(from - 1, to).join('\n');
  } else if (target.parser === 'markdown@1') {
    // A range is relative to the unavailable selected fragment, never to the whole Markdown file.
    if (target.range) return undefined;
    return text.replaceAll('\0', '');
  } else if (target.parser !== undefined) return undefined;
  return sliceRange(text, target.range);
}
export function judgeQuote(reference: string, quote: string, expected: string, inputs: QuoteInputs): QuoteFinding {
  const target = parseQuoteReference(reference);
  if (!target) return { ...unknown('other'), verdict: REFUTE, reason: undefined, gap: undefined };
  const run = object(inputs.run) && object(inputs.run.run) ? inputs.run.run : object(inputs.run) ? inputs.run : {};
  const defectDigests = new Set((Array.isArray(run.sources) ? run.sources : []).filter((s: any) => s.slot === 'defects').flatMap((s: any) => /^src:([a-f0-9]{64})/.exec(s.reference ?? '')?.[1] ?? []));
  const manuals = inputs.manual ?? [];
  let category: QuoteFinding['category'] = target.scheme === 'tree' && target.digest === run.root ? 'manual' : 'other';
  if (target.scheme === 'src' && defectDigests.has(target.digest!)) {
    category = !inputs.fixField ? 'unknown_defect_field' : target.parser === 'json@1' && target.segments?.at(-1) === inputs.fixField ? 'fix' : 'defect_other';
  } else if (target.scheme === 'src' && manuals.some(b => sha256(b) === target.digest)) category = 'manual';
  let text: string | null | undefined, scope: QuoteFinding['scope'] = 'fragment';
  if (target.scheme === 'tree') {
    scope = 'necessary';
    if (typeof run.root !== 'string' || !/^[a-f0-9]{64}$/.test(run.root)) return { ...unknown(category, reason('missing_input'), scope), gap: { fact: 'locked_run_root', action: 'read_run_show', owner: 'Claude' } };
    if (target.digest !== run.root) return { ...unknown('other'), verdict: REFUTE, scope, reason: undefined, gap: undefined };
    if (manuals.length === 0) return unknown(category, reason('missing_input'), scope);
    const texts = manuals.map(b => new TextDecoder('utf8', { fatal: true }).decode(b));
    const found = texts.find(t => quoteMatches(t, quote));
    return { verdict: found === undefined ? REFUTE : SUPPORT, category, scope, expectedVerbatim: found === undefined ? false : quoteMatches(found, expected) };
  }
  if (target.scheme !== 'src') return { ...unknown('unknown_target'), gap: { fact: 'record_or_entry_original_provenance', action: 'request_referenced_original_provenance', owner: 'Claude' } };
  const bytes = inputs.sources?.get(target.digest!) ?? manuals.find(b => sha256(b) === target.digest);
  if (!bytes) return unknown(category, reason('missing_input'));
  if (sha256(bytes) !== target.digest) throw new Error('source integrity mismatch');
  if (!Array.isArray(run.sources) && category === 'other') return { ...unknown(category, reason('missing_input')), gap: { fact: 'run_source_bindings', action: 'read_run_show', owner: 'Claude' } };
  scope = target.parser === 'markdown@1' ? 'necessary' : 'fragment';
  text = sourceText(bytes, target);
  if (text === undefined) return unknown(category, reason('no_check'), scope);
  if (text === null) return { ...unknown(category), verdict: REFUTE, reason: undefined, gap: undefined, scope };
  return { verdict: quoteMatches(text, quote) ? SUPPORT : REFUTE, category, scope, expectedVerbatim: quoteMatches(text, expected) };
}
export function quotesReport(submission: unknown, hub: unknown, inputs: QuoteInputs) {
  const drafts = locatedDrafts(submission);
  const shapes=drafts.filter(d=>!d.data.expected?.length).map(d=>({draft:d.draft,category:'expected_absent'}));
  const found = drafts.flatMap(d => (d.data.expected??[]).map((e, expected) => ({ item: d.item, draft: d.draft, expected: expected + 1,
    ...(!e.quote || typeof e.quote.reference !== 'string' || typeof e.quote.text !== 'string' ? {verdict:REFUTE,category:'quote_absent' as const,scope:'fragment' as const,expectedVerbatim:false} : judgeQuote(e.quote.reference, e.quote.text, e.text ?? '', inputs)),
  })));
  const items = [...new Set(drafts.map(d => d.item))].map(item => {
    const own = found.filter(f => f.item === item);
    const verdict = drafts.some(d=>d.item===item&&!d.data.expected?.length)||own.some(f => f.verdict === REFUTE) ? REFUTE : own.length === 0 || own.some(f => f.verdict === UNKNOWN) ? UNKNOWN : SUPPORT;
    const status=requirementStatus(hub,item,'grounded');
    return {verdict,comparison:compareStatus(verdict,status),hubOutputMissing:verdict!==UNKNOWN&&(status===null||status==='pending')};
  });
  return { shapes,counts: Object.fromEntries([SUPPORT, REFUTE, UNKNOWN].map(v => [v, found.filter(f => f.verdict === v).length])),
    targets: Object.fromEntries(['fix','defect_other','manual','other','unknown_defect_field','unknown_target','quote_absent'].map(c => [c, Object.fromEntries([SUPPORT, REFUTE, UNKNOWN].map(v => [v, found.filter(f => f.category === c && f.verdict === v).length]))])),
    expectedVerbatim: found.filter(f => f.verdict === SUPPORT && f.expectedVerbatim).length,
    paraphrased: found.filter(f => f.verdict === SUPPORT && f.expectedVerbatim === false).length,
    necessaryOnly: found.filter(f => f.scope === 'necessary').length, items,
    details: found.map(({ item, ...rest }) => rest),
  };
}
