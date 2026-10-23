// Independent value-domain oracle. Only the original XML reader and command tokenizer are shared with other gold scripts.
import { isIP } from 'node:net';
import { VERDICT, REASON, REQUIREMENT_STATUS, type Verdict, type RequirementStatus } from '../../../contracts/generated/vocabulary.ts';
import { XmlReader, type XmlNode } from './command-diff.ts';
import { buildCatalog, parseCommandsFromText, normalizeHead, type SplitCommand } from './regression-doc.ts';
const [SUPPORT, REFUTE, UNKNOWN] = VERDICT;
const NO_CHECK = REASON[0];
export interface DomainResult { verdict: Verdict; category: 'count' | 'type' | 'range' | 'enum' | 'no_check' | 'valid'; reason?: typeof NO_CHECK }
type Arg = { type: string; optional: boolean; limit: string; length: string; otherForm: boolean };
export type Domains = Map<string, Arg[][]>;
const kids = (n: XmlNode) => n.children.flatMap(c => 'element' in c ? [c.element] : []);
const text = (n: XmlNode): string => n.children.map(c => 'text' in c ? c.text : text(c.element)).join(' ');
const entity = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
  const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : e.startsWith('#') ? Number(e.slice(1)) : null;
  return code === null ? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m) : code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const unknown = (): DomainResult => ({ verdict: UNKNOWN, category: 'no_check', reason: NO_CHECK });
const result = (category: DomainResult['category']): DomainResult => ({ verdict: category === 'valid' ? SUPPORT : REFUTE, category });

export function commandDomains(xml: string): Domains {
  const out: Domains = new Map();
  // The shared format reader omits text immediately before a closing tag; retain arg bodies independently for exception disclosure.
  const helpBodies = [...xml.matchAll(/<arg\b[^>]*?(?:\/>|>([\s\S]*?)<\/arg\s*>)/g)].map(m => entity((m[1] ?? '').replace(/<[^>]*>/g, ' ')));
  let argument = 0;
  const walk = (node: XmlNode, words: string[]) => {
    const own = entity(node.attributes.name ?? '').trim().split(/\s+/).filter(Boolean);
    if (node.name === 'menu') words = [...words, ...own];
    if (node.name === 'item') {
      const head = normalizeHead([...words, ...own].join(' '));
      if (!head) return;
      const lists = kids(node).filter(n => n.name === 'arguments');
      const overloads = (lists.length ? lists : [{ ...node, children: [] }]).map(list => kids(list).filter(n => n.name === 'arg').map(arg => ({
        type: entity(arg.attributes.type ?? '').toUpperCase(), optional: /^(yes|y|true|1)$/i.test(arg.attributes.optional ?? ''),
        limit: entity(arg.attributes.limit ?? '').trim(), length: entity(arg.attributes.length ?? '').trim(),
        otherForm: /\bor\b|host\s*name|\burl\b|[a-z]+:\/\//i.test(`${text(arg)} ${helpBodies[argument++] ?? ''}`),
      })));
      out.set(head, [...(out.get(head) ?? []), ...overloads]);
      out.set(`no ${head}`, out.get(head)!);
      return;
    }
    for (const child of kids(node)) if (!['arguments', 'arg', 'results'].includes(child.name)) walk(child, words);
  };
  for (const root of XmlReader.read(xml)) walk(root, []);
  return out;
}

function bounds(raw: string): [number, number] | null {
  if (/^\d{1,15}$/.test(raw)) return [0, Number(raw)];
  const m = /^[\[(]?\s*(-?\d{1,15})\s*(?:-|~|\.\.|to)\s*(-?\d{1,15})\s*[\])]?$/.exec(raw);
  return m && Number(m[1]) <= Number(m[2]) ? [Number(m[1]), Number(m[2])] : null;
}
function checkArg(arg: Arg, value: string): DomainResult {
  let magnitude: number | undefined;
  switch (arg.type) {
    case 'STRING': case 'XSTRING': magnitude = [...value].length; break;
    case 'U16': case 'U32':
      if (!/^[+-]?\d+$/.test(value)) return result('type');
      magnitude = Number(value);
      if (!Number.isSafeInteger(magnitude) || magnitude < 0 || magnitude > (arg.type === 'U16' ? 65535 : 4294967295)) return result('range');
      break;
    case 'DOTTEDIP':
      if (arg.otherForm || isIP(value) !== 4) return unknown();
      break;
    case 'IPADDR': if (!isIP(value) || value.includes('%')) return result('type'); break;
    case 'IPMASK': {
      if (/^[+-]?\d+$/.test(value)) {
        const n = Number(value); if (n < 0 || n > 128) return result('range'); magnitude = n;
      } else {
        if (isIP(value) !== 4) return result('type');
        const bits = value.split('.').map(v => Number(v).toString(2).padStart(8, '0')).join('');
        if (!/^1*0*$/.test(bits)) return result('type');
      }
      break;
    }
    default: return unknown();
  }
  if (arg.limit) {
    const range = bounds(arg.limit);
    const enums = /^[{[(]?\s*([^\s|,{}()[\]]+(?:\s*[|,]\s*[^\s|,{}()[\]]+)+)\s*[}\])]?$/.exec(arg.limit);
    if (range) {
      if (magnitude === undefined) return unknown();
      if (magnitude < range[0] || magnitude > range[1]) return result('range');
    } else if (enums) {
      if (!enums[1].split(/\s*[|,]\s*/).includes(value)) return result('enum');
    } else return unknown();
  }
  if (arg.length) {
    const range = bounds(arg.length);
    if (!range) return unknown();
    const n = [...value].length;
    if (n < range[0] || n > range[1]) return result('range');
  }
  return result('valid');
}

export function judgeCommand(command: SplitCommand, domains: Domains): DomainResult {
  const overloads = domains.get(normalizeHead(command.head));
  if (!overloads) return unknown();
  const outcomes: DomainResult[] = [];
  for (const args of overloads) {
    let states: DomainResult[] = [];
    const cap = args.reduce((n, a) => n * (['IPADDR', 'IPMASK'].includes(a.type) ? 2 : 1), 1) > 32;
    const memo = new Map<string, DomainResult[]>();
    const visit = (i: number, j: number): DomainResult[] => {
      const key = `${i}/${j}`; if (memo.has(key)) return memo.get(key)!;
      if (i === args.length) return j === command.parameters.length ? [result('valid')] : [];
      const found: DomainResult[] = args[i].optional ? [...visit(i + 1, j)] : [];
      if (j < command.parameters.length) {
        const here = cap ? unknown() : checkArg(args[i], command.parameters[j]);
        for (const tail of visit(i + 1, j + 1)) found.push(here.verdict === REFUTE ? here : tail.verdict === REFUTE ? tail : here.verdict === UNKNOWN || tail.verdict === UNKNOWN ? unknown() : tail);
      }
      // Keep one representative of each classification; optional branches cannot cause exponential work.
      const compact = [...new Map(found.map(v => [v.category, v])).values()]; memo.set(key, compact); return compact;
    };
    states = visit(0, 0);
    outcomes.push(...(states.length ? states : [result('count')]));
  }
  return outcomes.find(o => o.verdict === SUPPORT) ?? outcomes.find(o => o.verdict === UNKNOWN) ?? outcomes.find(o => o.category !== 'count') ?? result('count');
}

export interface LocatedDraft { item: string; draft: number; data: { title?: string; negative?: boolean; expects_refutation?: boolean; steps?: { command?: string }[]; expected?: { text?: string; quote?: { text?: string; reference?: string } }[] } }
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export function locatedDrafts(submission: unknown): LocatedDraft[] {
  if (!object(submission) || !Array.isArray(submission.items)) return [];
  const out: LocatedDraft[] = [];
  for (const item of submission.items) if (object(item) && object(item.slots) && Array.isArray(item.slots.cases)) {
    for (const entry of item.slots.cases) if (object(entry) && object(entry.data)) out.push({ item: String(item.item ?? ''), draft: out.length + 1, data: entry.data });
  }
  return out;
}
export function requirementStatus(resultValue: unknown, item: string, key: string): RequirementStatus | null {
  const buckets = object(resultValue) && object(resultValue.partitions) ? Object.values(resultValue.partitions).flatMap(v => Array.isArray(v) ? v : []) : [];
  const found = buckets.filter(b => object(b) && b.item === item).flatMap(b => Array.isArray(b.requirements) ? b.requirements : []).filter(r => r.requirement === key);
  return found.length === 1 && REQUIREMENT_STATUS.includes(found[0].status) ? found[0].status : null;
}
export function compareStatus(verdict: Verdict, status: RequirementStatus | null): 'equal' | 'different' | 'unknown' {
  if (verdict === UNKNOWN || status === null || status === REQUIREMENT_STATUS[2]) return 'unknown';
  return (verdict === SUPPORT) === (status === REQUIREMENT_STATUS[0]) ? 'equal' : 'different';
}
export function parsedDraftCommands(draft: LocatedDraft, xml: string): { commands: SplitCommand[]; unrecognized: string[] } {
  const catalog = buildCatalog(xml);
  const commands: SplitCommand[] = [], unrecognized: string[] = [];
  for (const step of draft.data.steps ?? []) if (typeof step.command === 'string') {
    const parsed = parseCommandsFromText(step.command, catalog); commands.push(...parsed.commands); unrecognized.push(...parsed.unrecognized);
  }
  return { commands, unrecognized };
}
export function domainReport(submission: unknown, hub: unknown, xml: string) {
  const domains = commandDomains(xml), drafts = locatedDrafts(submission);
  const details = drafts.map(d => {
    const parsed = parsedDraftCommands(d, xml);
    const outcomes = [...parsed.commands.map(c => judgeCommand(c, domains)), ...parsed.unrecognized.map(() => unknown())];
    const verdict = outcomes.length === 0 || outcomes.some(o => o.verdict === UNKNOWN) ? UNKNOWN
      : d.data.expects_refutation === false ? outcomes.every(o => o.verdict === SUPPORT) ? SUPPORT : REFUTE
      : d.data.expects_refutation === true && d.data.negative === true ? outcomes.some(o => o.verdict === REFUTE) ? SUPPORT : REFUTE : UNKNOWN;
    return { draft: d.draft, item: d.item, outcomes, verdict };
  });
  const items = [...new Set(drafts.map(d => d.item))].map(item => {
    const own = details.filter(d => d.item === item);
    const verdict = own.some(d => d.verdict === UNKNOWN) ? UNKNOWN : own.some(d => d.verdict === REFUTE) ? REFUTE : SUPPORT;
    return { verdict, comparison: compareStatus(verdict, requirementStatus(hub, item, 'commands')) };
  });
  return { counts: Object.fromEntries([SUPPORT, REFUTE, UNKNOWN].map(v => [v, details.flatMap(d => d.outcomes).filter(o => o.verdict === v).length])), items, details: details.map(({ item, ...rest }) => rest) };
}
