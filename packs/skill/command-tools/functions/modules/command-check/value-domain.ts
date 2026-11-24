export const VALUE_RULE_KINDS = ['max_bytes', 'max_characters', 'part_max_characters', 'allowed_specials', 'forbidden_characters', 'not_at_start', 'not_at_end', 'wildcard', 'reserved_words', 'no_whitespace'] as const;
export type ValueRuleKind = typeof VALUE_RULE_KINDS[number];

export type ValueRule =
  | { kind: 'max_bytes'; limit: number; quote: string }
  | { kind: 'max_characters'; limit: number; quote: string }
  | { kind: 'part_max_characters'; limit: number; separator: string; quote: string }
  | { kind: 'allowed_specials'; characters: string[]; quote: string }
  | { kind: 'forbidden_characters'; characters: string[]; quote: string }
  | { kind: 'not_at_start'; characters: string[]; quote: string }
  | { kind: 'not_at_end'; characters: string[]; quote: string }
  | { kind: 'wildcard'; character: string; quote: string }
  | { kind: 'reserved_words'; words: string[]; case_insensitive: boolean; quote: string }
  | { kind: 'no_whitespace'; quote: string };

export interface ValueDomainClaim {
  commands: string[];
  parameter: string;
  reference: string;
  row: string;
  rules: ValueRule[];
  record?: string;
}

export const TEXT_PARAMETER_TYPES: readonly string[] = ['string', 'hostname', 'ip_or_hostname'];

const MAX_LIMIT = 1_000_000;
const MAX_QUOTE = 4096;
const MAX_ROW = 65536;
const MAX_RULES = VALUE_RULE_KINDS.length;
const MAX_CHARACTERS = 64;
const MAX_WORDS = 32;
const MAX_WORD = 64;
const MAX_COMMANDS = 16;
const MAX_CLAIMS = 2048;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWhite = (character: string): boolean => character.trim() === '';
const isAsciiAlnum = (character: string): boolean => character.length === 1 && (character >= '0' && character <= '9' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z');
const isCharacter = (value: unknown): value is string => typeof value === 'string' && [...value].length === 1;

function characterList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHARACTERS || !value.every(isCharacter) || new Set(value).size !== value.length) return null;
  return value as string[];
}

function shown(character: string): string {
  if (character === ' ') return '空格';
  if (character === '\t') return '制表符';
  const code = character.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f || isWhite(character)) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `“${character}”`;
}
const shownList = (characters: readonly string[]): string => characters.slice(0, 8).map(shown).join('、') + (characters.length > 8 ? ` 等 ${characters.length} 个` : '');

function readRule(value: unknown, at: string, problems: string[]): ValueRule | null {
  if (!isRecord(value) || typeof value.kind !== 'string') { problems.push(`${at}不是带 kind 的对象`); return null; }
  const kind = value.kind;
  if (!(VALUE_RULE_KINDS as readonly string[]).includes(kind)) { problems.push(`${at}的 kind “${kind.slice(0, 40)}”不在规则种类里（${VALUE_RULE_KINDS.join('、')}）`); return null; }
  const fields: Record<string, readonly string[]> = {
    max_bytes: ['limit'], max_characters: ['limit'], part_max_characters: ['limit', 'separator'], allowed_specials: ['characters'],
    forbidden_characters: ['characters'], not_at_start: ['characters'], not_at_end: ['characters'], wildcard: ['character'],
    reserved_words: ['words', 'case_insensitive'], no_whitespace: [],
  };
  const extra = Object.keys(value).filter((key) => key !== 'kind' && key !== 'quote' && !fields[kind]!.includes(key));
  if (extra.length > 0) { problems.push(`${at}（${kind}）有不属于这种规则的字段：${extra.slice(0, 5).join('、')}`); return null; }
  const quote = value.quote;
  if (typeof quote !== 'string' || quote.length < 1 || quote.length > MAX_QUOTE) { problems.push(`${at}（${kind}）的 quote 要写手册这一行里的原句，1 到 ${MAX_QUOTE} 个字`); return null; }
  const limit = (): number | null => {
    if (typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= MAX_LIMIT) return value.limit;
    problems.push(`${at}（${kind}）的 limit 要写 1 到 ${MAX_LIMIT} 的整数`); return null;
  };
  const characters = (name: string): string[] | null => {
    const list = characterList(value[name]);
    if (list === null) problems.push(`${at}（${kind}）的 ${name} 要写 1 到 ${MAX_CHARACTERS} 个互不相同的单个字符`);
    return list;
  };
  switch (kind as ValueRuleKind) {
    case 'max_bytes': case 'max_characters': { const n = limit(); return n === null ? null : { kind: kind as 'max_bytes' | 'max_characters', limit: n, quote }; }
    case 'part_max_characters': {
      const n = limit();
      if (!isCharacter(value.separator)) { problems.push(`${at}（${kind}）的 separator 要写一个字符`); return null; }
      return n === null ? null : { kind: 'part_max_characters', limit: n, separator: value.separator, quote };
    }
    case 'allowed_specials': case 'forbidden_characters': case 'not_at_start': case 'not_at_end': {
      const list = characters('characters');
      if (list === null) return null;
      if (kind === 'allowed_specials' && list.some(isAsciiAlnum)) { problems.push(`${at}（${kind}）里不能有字母和数字：字母和数字本来就允许，这里只列特殊字符`); return null; }
      return { kind: kind as 'allowed_specials' | 'forbidden_characters' | 'not_at_start' | 'not_at_end', characters: list, quote };
    }
    case 'wildcard':
      if (!isCharacter(value.character) || isWhite(value.character)) { problems.push(`${at}（${kind}）的 character 要写一个非空白字符`); return null; }
      return { kind: 'wildcard', character: value.character, quote };
    case 'reserved_words': {
      const words = value.words;
      if (!Array.isArray(words) || words.length < 1 || words.length > MAX_WORDS || new Set(words).size !== words.length
        || !words.every((word) => typeof word === 'string' && word.length >= 1 && [...word].length <= MAX_WORD && ![...word].some(isWhite))) {
        problems.push(`${at}（${kind}）的 words 要写 1 到 ${MAX_WORDS} 个互不相同、不含空白的词，每个不超过 ${MAX_WORD} 个字符`); return null;
      }
      if (typeof value.case_insensitive !== 'boolean') { problems.push(`${at}（${kind}）的 case_insensitive 要写 true 或 false`); return null; }
      return { kind: 'reserved_words', words: words as string[], case_insensitive: value.case_insensitive, quote };
    }
    case 'no_whitespace': return { kind: 'no_whitespace', quote };
  }
}

export function readValueRules(value: unknown): { rules: ValueRule[] } | { problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RULES) return { problems: [`rules 要写 1 到 ${MAX_RULES} 条规则`] };
  const rules: ValueRule[] = [];
  value.forEach((one, index) => { const rule = readRule(one, `第 ${index + 1} 条规则`, problems); if (rule !== null) rules.push(rule); });
  if (problems.length > 0) return { problems };
  const kinds = rules.map((rule) => rule.kind);
  const twice = kinds.find((kind, index) => kinds.indexOf(kind) !== index);
  if (twice !== undefined) return { problems: [`同一种规则（${twice}）写了不止一条；一种规则只写一条`] };
  const clash = contradiction(rules);
  if (clash !== null) return { problems: [clash.message] };
  return { rules };
}

function contradiction(rules: readonly ValueRule[]): { kinds: ValueRuleKind[]; message: string } | null {
  const allowed = new Set(rules.flatMap((rule) => rule.kind === 'allowed_specials' ? rule.characters : []));
  const forbidden = new Set(rules.flatMap((rule) => rule.kind === 'forbidden_characters' ? rule.characters : []));
  const both = [...allowed].filter((character) => forbidden.has(character));
  if (both.length > 0) return { kinds: ['allowed_specials', 'forbidden_characters'], message: `允许的特殊字符和禁用的字符互相矛盾：${shownList(both)}` };
  const wildcard = rules.find((rule) => rule.kind === 'wildcard');
  if (wildcard?.kind === 'wildcard' && forbidden.has(wildcard.character)) return { kinds: ['wildcard', 'forbidden_characters'], message: `通配符${shown(wildcard.character)}同时写在禁用的字符里` };
  return null;
}

const isCommand = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 512 && value.split(' ').every((word) => word.length > 0 && ![...word].some(isWhite));

export function readValueDomainClaim(value: unknown): { claim: ValueDomainClaim } | { problems: string[] } {
  if (!isRecord(value)) return { problems: ['主张不是对象'] };
  const extra = Object.keys(value).filter((key) => !['commands', 'parameter', 'reference', 'row', 'rules', 'record'].includes(key));
  if (extra.length > 0) return { problems: [`主张有不认识的字段：${extra.slice(0, 5).join('、')}`] };
  const { commands, parameter, reference, row, record } = value;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > MAX_COMMANDS || !commands.every(isCommand) || new Set(commands).size !== commands.length) return { problems: [`commands 要写 1 到 ${MAX_COMMANDS} 个互不相同的命令写法（词用一个空格隔开）`] };
  if (typeof parameter !== 'string' || parameter.length < 1 || parameter.length > 200 || [...parameter].some(isWhite)) return { problems: ['parameter 要写参数名，不含空白'] };
  if (typeof reference !== 'string' || !reference.startsWith('tree:') || reference.length > 8192) return { problems: ['reference 要写手册这一行在锁定树里的引用（tree:…）'] };
  if (typeof row !== 'string' || row.length < 1 || row.length > MAX_ROW) return { problems: [`row 要写手册这一行的原文，1 到 ${MAX_ROW} 个字`] };
  if (record !== undefined && (typeof record !== 'string' || record.length < 1 || record.length > 200)) return { problems: ['record 要写 Hub 保存这条主张的记录引用'] };
  const rules = readValueRules(value.rules);
  if ('problems' in rules) return rules;
  return { claim: { commands: commands as string[], parameter, reference, row, rules: rules.rules, ...(record === undefined ? {} : { record }) } };
}

export function readValueDomainClaims(value: unknown): ValueDomainClaim[] {
  if (!Array.isArray(value)) return [];
  const claims: ValueDomainClaim[] = [];
  for (const one of value.slice(0, MAX_CLAIMS)) { const read = readValueDomainClaim(one); if ('claim' in read && claimProblems(read.claim.rules, read.claim.row).length === 0) claims.push(read.claim); }
  return claims;
}

function digitRuns(text: string): string[] {
  const runs: string[] = [];
  let run = '';
  for (const character of text) {
    if (character >= '0' && character <= '9') run += character;
    else { if (run !== '') runs.push(run); run = ''; }
  }
  if (run !== '') runs.push(run);
  return runs;
}

export function claimProblems(rules: readonly ValueRule[], row: string): string[] {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    const at = `第 ${index + 1} 条规则（${rule.kind}）`;
    if (!row.includes(rule.quote)) { problems.push(`${at}的引文不是手册这一行里的原句`); return; }
    const missing = (literal: string): boolean => !rule.quote.includes(literal);
    switch (rule.kind) {
      case 'max_bytes': case 'max_characters': case 'part_max_characters':
        if (!digitRuns(rule.quote).includes(String(rule.limit))) problems.push(`${at}的数字 ${rule.limit} 没有作为完整的一串数字出现在它的引文里`);
        if (rule.kind === 'part_max_characters' && missing(rule.separator)) problems.push(`${at}的分隔字符${shown(rule.separator)}没有出现在它的引文里`);
        break;
      case 'allowed_specials': case 'forbidden_characters': case 'not_at_start': case 'not_at_end': {
        const absent = rule.characters.filter(missing);
        if (absent.length > 0) problems.push(`${at}的字符${shownList(absent)}没有出现在它的引文里`);
        break;
      }
      case 'wildcard': if (missing(rule.character)) problems.push(`${at}的通配符${shown(rule.character)}没有出现在它的引文里`); break;
      case 'reserved_words': {
        const absent = rule.words.filter(missing);
        if (absent.length > 0) problems.push(`${at}的词${absent.slice(0, 8).map((word) => `“${word}”`).join('、')}没有出现在它的引文里`);
        break;
      }
      case 'no_whitespace': break;
    }
  });
  return problems;
}

export function rowProblems(entryData: unknown, commands: readonly string[], parameter: string): string[] {
  const stated = isRecord(entryData) && isRecord(entryData.parameter) ? entryData.parameter : null;
  if (stated === null || !Array.isArray(stated.commands) || !stated.commands.every((one) => typeof one === 'string') || typeof stated.name !== 'string') return ['这一行没有记着它说明哪条命令的哪个参数，不是说明某个参数的手册行'];
  const problems: string[] = [];
  if (stated.name !== parameter) problems.push(`这一行说明的参数是 ${stated.name}，不是 ${parameter}`);
  const absent = commands.filter((command) => !(stated.commands as string[]).includes(command));
  if (absent.length > 0) problems.push(`这一行说明的命令写法是${(stated.commands as string[]).map((one) => `“${one}”`).join('、')}，没有${absent.map((one) => `“${one}”`).join('、')}`);
  return problems;
}

export interface TreeCommand { words: readonly string[]; signatures: ReadonlyArray<{ params: ReadonlyArray<{ name: string; type?: string }> }> }
export function bindingProblems(tree: readonly TreeCommand[], commands: readonly string[], parameter: string): string[] {
  const problems: string[] = [];
  for (const command of commands) {
    const entry = tree.find((one) => one.words.join(' ') === command);
    if (entry === undefined) { problems.push(`锁定命令树里没有命令“${command}”`); continue; }
    const usable = entry.signatures.some((signature) => { const named = signature.params.filter((one) => one.name === parameter); return named.length === 1 && TEXT_PARAMETER_TYPES.includes(named[0]!.type ?? ''); });
    if (!usable) problems.push(`命令“${command}”在锁定命令树里没有名叫 ${parameter} 的文本类参数（同名的参数要恰好一个），这条主张用不上`);
  }
  return problems;
}

export interface ValueViolation { rule: number; kind: ValueRuleKind; message: string }

export function checkValue(rules: readonly ValueRule[], value: string): ValueViolation[] {
  const out: ValueViolation[] = [];
  const characters = [...value];
  const wildcard = rules.find((rule) => rule.kind === 'wildcard');
  rules.forEach((rule, index) => {
    const broken = (message: string): number => out.push({ rule: index, kind: rule.kind, message });
    switch (rule.kind) {
      case 'max_bytes': { const n = new TextEncoder().encode(value).length; if (n > rule.limit) broken(`长度 ${n} 个字节，手册写的上限是 ${rule.limit} 个字节`); break; }
      case 'max_characters': if (characters.length > rule.limit) broken(`长度 ${characters.length} 个字符，手册写的上限是 ${rule.limit} 个字符`); break;
      case 'part_max_characters': {
        const parts = value.split(rule.separator);
        const at = parts.findIndex((part) => [...part].length > rule.limit);
        if (at >= 0) broken(`按“${rule.separator}”分开后第 ${at + 1} 段有 ${[...parts[at]!].length} 个字符，手册写的每段上限是 ${rule.limit} 个字符`);
        break;
      }
      case 'allowed_specials': {
        const wild = wildcard?.kind === 'wildcard' ? wildcard.character : null;
        const extra = [...new Set(characters.filter((character) => !isAsciiAlnum(character) && !rule.characters.includes(character) && character !== wild))];
        if (extra.length > 0) broken(`含手册没有允许的字符${shownList(extra)}（手册只允许字母、数字和${shownList(rule.characters)}）`);
        break;
      }
      case 'forbidden_characters': {
        const found = [...new Set(characters.filter((character) => rule.characters.includes(character)))];
        if (found.length > 0) broken(`含手册写明禁用的字符${shownList(found)}`);
        break;
      }
      case 'not_at_start': if (characters.length > 0 && rule.characters.includes(characters[0]!)) broken(`不能以${shown(characters[0]!)}开头（手册写明）`); break;
      case 'not_at_end': if (characters.length > 0 && rule.characters.includes(characters.at(-1)!)) broken(`不能以${shown(characters.at(-1)!)}结尾（手册写明）`); break;
      case 'wildcard': if (characters.indexOf(rule.character, 1) >= 0) broken(`通配符${shown(rule.character)}只能放在取值的最前面`); break;
      case 'reserved_words': {
        const word = rule.words.find((one) => rule.case_insensitive ? one.toLowerCase() === value.toLowerCase() : one === value);
        if (word !== undefined) broken(`取值“${word}”是手册写明的保留字${rule.case_insensitive ? '（不分大小写）' : ''}`);
        break;
      }
      case 'no_whitespace': if (characters.some(isWhite)) broken('含空白字符，手册写明取值不能包含空格'); break;
    }
  });
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
function sameRule(a: ValueRule, b: ValueRule): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'max_bytes': case 'max_characters': return a.limit === (b as typeof a).limit;
    case 'part_max_characters': return a.limit === (b as typeof a).limit && a.separator === (b as typeof a).separator;
    case 'allowed_specials': case 'forbidden_characters': case 'not_at_start': case 'not_at_end': return sameList(a.characters, (b as typeof a).characters);
    case 'wildcard': return a.character === (b as typeof a).character;
    case 'reserved_words': return a.case_insensitive === (b as typeof a).case_insensitive && sameList(a.words, (b as typeof a).words);
    case 'no_whitespace': return true;
  }
}

export interface RuleInUse { rule: ValueRule; claim: ValueDomainClaim }

export function effectiveRules(claims: readonly ValueDomainClaim[]): { rules: RuleInUse[]; disagreed: ValueRuleKind[] } {
  const rules: RuleInUse[] = [];
  const disagreed: ValueRuleKind[] = [];
  for (const kind of VALUE_RULE_KINDS) {
    const stated = claims.flatMap((claim) => claim.rules.filter((rule) => rule.kind === kind).map((rule) => ({ rule, claim })));
    if (stated.length === 0) continue;
    if (stated.every((one) => sameRule(one.rule, stated[0]!.rule))) rules.push(stated[0]!);
    else disagreed.push(kind);
  }
  for (let clash = contradiction(rules.map((one) => one.rule)); clash !== null; clash = contradiction(rules.map((one) => one.rule))) {
    for (const kind of clash.kinds) { rules.splice(rules.findIndex((one) => one.rule.kind === kind), 1); disagreed.push(kind); }
  }
  return { rules, disagreed };
}

export interface BoundParameter { name: string; text: string | null }
export interface ValueDomainRefusal { parameter: string; value: string; violations: Array<ValueViolation & { rule_quote: string; claim: ValueDomainClaim }> }

export function valueDomainRefusals(command: string, parameters: readonly BoundParameter[], claims: readonly ValueDomainClaim[]): ValueDomainRefusal[] {
  const here = claims.filter((claim) => claim.commands.includes(command));
  const out: ValueDomainRefusal[] = [];
  for (const name of [...new Set(here.map((claim) => claim.parameter))]) {
    const named = parameters.filter((parameter) => parameter.name === name);
    if (named.length !== 1 || named[0]!.text === null) continue;
    const { rules } = effectiveRules(here.filter((claim) => claim.parameter === name));
    const violations = checkValue(rules.map((one) => one.rule), named[0]!.text).map((violation) => ({ ...violation, rule_quote: rules[violation.rule]!.rule.quote, claim: rules[violation.rule]!.claim }));
    if (violations.length > 0) out.push({ parameter: name, value: named[0]!.text, violations });
  }
  return out;
}
