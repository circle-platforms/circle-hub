// Independent value-domain oracle. Only the original XML reader and command tokenizer are shared with other gold scripts.
import { isIP } from 'node:net';
import { VERDICT, REASON, REQUIREMENT_STATUS, type Verdict, type RequirementStatus } from '../../../contracts/generated/vocabulary.ts';
import { parseCommandTree, type CommandCatalogDeclaration } from './compile-check.ts';
import { XmlReader, type XmlNode } from './command-diff.ts';
import { buildCatalog, commandTokens, matchCatalogCommands, normalizeHead, type SplitCommand } from './regression-doc.ts';
const [SUPPORT, REFUTE, UNKNOWN] = VERDICT;
const NO_CHECK = REASON[0];
/** Decode original command-tree bytes according to their XML declaration, without changing the stored bytes or digest. */
export function decodeCommandXml(bytes: Uint8Array): string {
  const header = Buffer.from(bytes).subarray(0, 200).toString('ascii');
  const encoding = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(header)?.[1] ?? 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
export interface DomainResult { verdict: Verdict; category: 'count' | 'type' | 'range' | 'enum' | 'no_check' | 'valid' | 'not_member'; reason?: typeof NO_CHECK; gap?: { fact: string; action: string; owner: string } }
type Arg = { type: string; optional: boolean; limit: string; length: string; otherForm: boolean };
export type Domains = Map<string, Arg[][]> & {case_sensitive?:boolean};
const kids = (n: XmlNode) => n.children.flatMap(c => 'element' in c ? [c.element] : []);
const text = (n: XmlNode): string => n.children.map(c => 'text' in c ? c.text : text(c.element)).join(' ');
const entity = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
  const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : e.startsWith('#') ? Number(e.slice(1)) : null;
  return code === null ? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m) : code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const unknown = (fact = 'argument_domain_rule'): DomainResult => ({ verdict: UNKNOWN, category: 'no_check', reason: NO_CHECK, gap: { fact, action: 'request_rule_from_named_integrator', owner: 'Claude' } });
const result = (category: DomainResult['category']): DomainResult => ({ verdict: category === 'valid' ? SUPPORT : REFUTE, category });

export function commandDomains(xml: string,declaration?:CommandCatalogDeclaration): Domains {
  const parsed = parseCommandTree(xml);
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
      const overloads = (lists.length ? lists : [{ ...node, children: [] }]).map(list => kids(list).filter(n => n.name === 'arg').map(arg => {
        const body=helpBodies[argument++]??'';
        return ({
        type: entity(arg.attributes.type ?? '').toUpperCase(), optional: /^(yes|y|true|1)$/i.test(arg.attributes.optional ?? ''),
        limit: entity(arg.attributes.limit ?? '').trim(), length: entity(arg.attributes.length ?? '').trim(),
        otherForm: /\bor\b|host\s*name|\burl\b|[a-z]+:\/\//i.test(entity(arg.attributes.help_string??'')||`${text(arg)} ${body}`),
      });}));
      out.set(head, [...(out.get(head) ?? []), ...overloads]);
      return;
    }
    for (const child of kids(node)) if (!['arguments', 'arg', 'results'].includes(child.name)) walk(child, words);
  };
  for (const root of XmlReader.read(xml)) walk(root, []);
  const domains: Domains = new Map();domains.case_sensitive=declaration?.case_sensitive;
  for (const entry of parsed) {
    const head = normalizeHead(entry.words.join(' '));
    domains.set(head, entry.overloads.map((args, overload) => args.map((arg, position) => ({
      type: arg.type.toUpperCase(), optional: arg.optional, limit: arg.limit ?? '', length: arg.length ?? '',
      otherForm: out.get(head)?.[overload]?.[position]?.otherForm ?? false,
    }))));
  }
  return domains;
}

function bounds(raw: string): [number, number] | null {
  if (/^\d{1,15}$/.test(raw)) return [0, Number(raw)];
  const m = /^[\[(]?\s*(-?\d{1,15})\s*(?:-|~|\.\.|to)\s*(-?\d{1,15})\s*[\])]?$/.exec(raw);
  return m && Number(m[1]) <= Number(m[2]) ? [Number(m[1]), Number(m[2])] : null;
}
function checkArg(arg: Arg, value: string,caseSensitive?:boolean): DomainResult {
  let magnitude: number | undefined;
  switch (arg.type) {
    case 'STRING': case 'XSTRING': magnitude = [...value].length; break;
    case 'U16': case 'U32':
      if (!/^[+-]?\d+$/.test(value)) return result('type');
      magnitude = Number(value);
      if (!Number.isSafeInteger(magnitude) || magnitude < 0 || magnitude > (arg.type === 'U16' ? 65535 : 4294967295)) return result('range');
      break;
    case 'DOTTEDIP':
      if (arg.otherForm) return unknown('DOTTEDIP_alternative_domain');
      if(isIP(value)!==4)return result('type');
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
    default: return unknown('declared_argument_type_rule');
  }
  if (arg.limit) {
    const range = /^\[\s*-?\d{1,15}\s*-\s*-?\d{1,15}\s*\]$/.test(arg.limit)?bounds(arg.limit):null;
    const enums = /^\{([^{}|]+(?:\|[^{}|]+)+)\}$/.exec(arg.limit);
    if (range) {
      if (magnitude === undefined) return unknown();
      if (magnitude < range[0] || magnitude > range[1]) return result('range');
    } else if (enums) {
      const values=enums[1].split('|').map(part=>part.trim());
      if(!values.includes(value)){
        const folded=values.some(choice=>choice.toLowerCase()===value.toLowerCase());
        if(folded&&caseSensitive===undefined)return {...unknown('catalog_case_sensitivity'),gap:{fact:'catalog_case_sensitivity',action:'supply_product_declaration_and_rerun',owner:'Claude'}};
        if(!folded||caseSensitive!==false)return result('enum');
      }
    } else return unknown('argument_limit_rule');
  }
  if (arg.length) {
    const range = bounds(arg.length);
    if (!range) return unknown('argument_length_rule');
    const n = [...value].length;
    if (n < range[0] || n > range[1]) return result('range');
  }
  return result('valid');
}

export function judgeCommand(command: SplitCommand, domains: Domains): DomainResult {
  const overloads = domains.get(normalizeHead(command.head));
  if (!overloads) return result('not_member');
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
        const here = cap ? unknown('expanded_overload_domain') : checkArg(args[i], command.parameters[j],domains.case_sensitive);
        for (const tail of visit(i + 1, j + 1)) found.push(here.verdict === REFUTE ? here : tail.verdict === REFUTE ? tail : here.verdict === UNKNOWN ? here : tail);
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
  if (verdict === UNKNOWN) return 'unknown';
  if(status===null||status===REQUIREMENT_STATUS[2])return 'different';
  return (verdict === SUPPORT) === (status === REQUIREMENT_STATUS[0]) ? 'equal' : 'different';
}
export function parsedDraftCommands(draft: LocatedDraft, xml: string): { commands: SplitCommand[]; unrecognized: string[]; located: { step: number; line: number; command: SplitCommand | null }[] } {
  const catalog = buildCatalog(xml);
  const commands: SplitCommand[] = [], unrecognized: string[] = [], located: { step: number; line: number; command: SplitCommand | null }[] = [];
  for (const [step, raw] of (draft.data.steps ?? []).entries()) if (typeof raw.command === 'string') {
    for (const [line, text] of raw.command.split(/\r?\n/).entries()) if (text.trim()) {
      const tokens=commandTokens(text).flatMap(token=>token.quoted?[token]:token.text.split(/([;；])/u).filter(Boolean).map(part=>({...token,text:part,junk:token.junk||/^[;；]$/u.test(part)})));
      const parsed=matchCatalogCommands(tokens,catalog);
      commands.push(...parsed);
      let at=0,missed=false;
      for(const command of parsed){
        const words=command.head.split(' ');
        while(at<tokens.length&&!words.every((word,index)=>!tokens[at+index]?.junk&&tokens[at+index]?.text===word)){
          if(!tokens[at].junk)missed=true;
          at++;
        }
        at+=words.length+command.parameters.length;
        located.push({step:step+1,line:line+1,command});
      }
      if(tokens.slice(at).some(token=>!token.junk))missed=true;
      if(missed||parsed.length===0){unrecognized.push(text);located.push({step:step+1,line:line+1,command:null});}

    }
  }
  return { commands, unrecognized, located };
}

// A counterfactual diagnostic only, never the independent answer: whitespace arguments, fixed positions,
// and integer/port ranges are the two documented simplifications of the package's refutation check.
function simplifiedStep(raw: string, domains: Domains): boolean {
  const words = normalizeHead(raw).split(' ').filter(Boolean);
  for (const [head, overloads] of domains) {
    const prefix = head.split(' ');
    if (!prefix.every((w, i) => words[i] === w)) continue;
    const values = words.slice(prefix.length);
    for (const args of overloads) {
      if (values.length < args.filter(a => !a.optional).length || values.length > args.length) continue;
      const valid = values.every((value, i) => {
        const arg = args[i];
        if (!['U16', 'U32'].includes(arg.type) || /[|,]/.test(arg.limit)) return true;
        const n = Number(value), range = arg.limit ? bounds(arg.limit) : null;
        return Number.isInteger(n) && n >= Math.max(0, range?.[0] ?? 0) && n <= Math.min(arg.type === 'U16' ? 65535 : 4294967295, range?.[1] ?? Infinity);
      });
      if (valid) return true;
    }
  }
  return false;
}
export function domainReport(submission: unknown, hub: unknown, xml: string,declaration?:CommandCatalogDeclaration) {
  const domains = commandDomains(xml,declaration), drafts = locatedDrafts(submission);
  const details = drafts.map(d => {
    const parsed = parsedDraftCommands(d, xml);
    const outcomes = parsed.located.map(position => ({ ...(position.command ? judgeCommand(position.command, domains) : result('not_member')), step: position.step, line: position.line }));
    const expects = d.data.expects_refutation === true;
    const verdict = outcomes.length === 0 ? UNKNOWN
      : !expects ? outcomes.every(o => o.verdict === SUPPORT) ? SUPPORT : outcomes.some(o => o.verdict === REFUTE) ? REFUTE : UNKNOWN
      : d.data.negative === true ? outcomes.some(o => o.verdict === REFUTE) ? SUPPORT : outcomes.every(o => o.verdict === SUPPORT) ? REFUTE : UNKNOWN : UNKNOWN;
    const steps = (d.data.steps ?? []).flatMap((step, i) => {
      if (!step.command?.trim()) return [];
      const own = outcomes.filter(o => o.step === i + 1);
      const catalog = own.some(o => o.verdict === REFUTE) ? REFUTE : own.length > 0 && own.every(o => o.verdict === SUPPORT) ? SUPPORT : UNKNOWN;
      return [{ step: i + 1, catalog, simple: simplifiedStep(step.command, domains) }];
    });
    const stepRule = !expects ? verdict : d.data.negative === true ? steps.some(s => s.catalog === SUPPORT) ? REFUTE : steps.length > 0 && steps.every(s => s.catalog === REFUTE) ? SUPPORT : UNKNOWN : UNKNOWN;
    const simpleRule = expects && d.data.negative === true ? steps.some(s => s.simple) ? REFUTE : SUPPORT : !expects ? steps.every(s => s.simple) ? SUPPORT : REFUTE : UNKNOWN;
    return { draft: d.draft, item: d.item, outcomes, verdict, steps, stepRule, simpleRule };
  });
  const differences: { draft: number; step?: number; category: string }[] = [];
  const aggregate = (values: Verdict[]) => values.some(v => v === REFUTE) ? REFUTE : values.some(v => v === UNKNOWN) ? UNKNOWN : SUPPORT;
  const items = [...new Set(drafts.map(d => d.item))].map(item => {
    const own = details.filter(d => d.item === item), verdict = aggregate(own.map(d => d.verdict));
    const hasUnknown = own.some(d => d.verdict === UNKNOWN || d.outcomes.some(o => o.verdict === UNKNOWN));
    const status = requirementStatus(hub, item, 'commands'), comparison = compareStatus(verdict, status);
    const start = differences.length;
    if(comparison==='different'&&(status===null||status===REQUIREMENT_STATUS[2]))for(const d of own)differences.push({draft:d.draft,category:'hub_output_missing'});
    else if (comparison === 'different') {
      if (compareStatus(aggregate(own.map(d => d.stepRule)), status) === 'equal') {
        for (const d of own.filter(d => d.stepRule !== d.verdict)) for (const step of d.steps.filter(s => s.catalog === SUPPORT)) differences.push({ draft: d.draft, step: step.step, category: 'negative_step_rule' });
      }
      if (compareStatus(aggregate(own.map(d => d.simpleRule)), status) === 'equal') {
        for (const d of own.filter(d => d.simpleRule !== d.verdict)) for (const step of d.steps.filter(s => s.catalog !== UNKNOWN && (s.catalog === SUPPORT) !== s.simple)) differences.push({ draft: d.draft, step: step.step, category: 'simplified_refutation_match' });
      }
    }
    return { verdict, hasUnknown, comparison, differenceCategories: [...new Set(differences.slice(start).map(d => d.category))] };
  });
  return { counts: Object.fromEntries([SUPPORT, REFUTE, UNKNOWN].map(v => [v, details.flatMap(d => d.outcomes).filter(o => o.verdict === v).length])), notMember: details.flatMap(d => d.outcomes).filter(o => o.category === 'not_member').length, differences, items, details: details.map(({ item, ...rest }) => rest) };
}
