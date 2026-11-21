// Why a replacement source is refused, in the shared form of a refusal (functions/refusal-form.ts), and where the address comes from
// when the plan's frozen recomposition record holds it. The rule is not here: only an address the locked tree parses out of the
// author's own commands may be replaced (checks.ts, decision 115). Round 37: all three writers wrote the documentation address that
// the recompose step puts into its adapted commands when the author left an address undetermined (192.0.2.10, 2001:db8::1, ...)
// as the source of a replacement, were refused with the rule alone, and found by trial that the bed address goes into the step.
// This module only reads; it decides nothing and rewrites nothing.
import { addressKey, addressValue } from './manifest.ts';
import { compileGrammar, commandIdentity } from './generated/skills/command-tools/command-check/grammar.ts';
import { commandDefinitions } from './command-obligations.ts';
import { identityOf } from './typed-contract.ts';
import { isRecord } from './text.ts';
import { PLAN_DATA, refusalText, shownValue } from './refusal-form.ts';

/** RFC 5737 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and RFC 3849 (2001:db8::/32): the addresses the recompose rule writes when the author left one undetermined. */
export function isDocumentationAddress(text: string): boolean {
  const v4 = addressValue('ipv4', text);
  if (v4 !== null) return [0xc0000200n, 0xc6336400n, 0xcb007100n].some((base) => v4 >> 8n === base >> 8n);
  const v6 = addressValue('ipv6', text);
  return v6 !== null && v6 >> 96n === 0x20010db8n;
}

export interface RecordPlace {
  /** An address parameter of an adapted command, read by the locked tree; or inside a sentence of the record, found by the value as written. */
  how: 'command' | 'sentence';
  /** Where it sits, as a JSON Pointer into the frozen recomposition record. */
  at: string;
  /** The author step of the adapted row (command). */
  atom?: string;
  /** What the record's own notes call a sentence ("unknowns 第 2 条"). */
  label?: string;
  /** The command line (command), or the words around the address (sentence). */
  text: string;
  /** command: the line with this address written as the bed address, when that is one. */
  fixed?: string;
}

/** The address as one token: not the start, the end or the middle of a longer address or word (192.0.2.1 is not in 192.0.2.10). */
function token(address: string): RegExp {
  const v6 = address.includes(':'), escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return v6 ? new RegExp(`(?<![0-9A-Fa-f:])${escaped}(?![0-9A-Fa-f:])`, 'gi') : new RegExp(`(?<![0-9A-Za-z.])${escaped}(?![0-9A-Za-z]|\\.[0-9])`, 'g');
}
const AROUND = 40;
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - AROUND), end = Math.min(text.length, index + length + AROUND);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * Where the recomposition record holds `source`: first as an address parameter of an adapted command (each command read by the
 * locked tree, compared by address value, so 2001:0DB8::1 is 2001:db8::1), then, apart, in the sentences the record keeps beside
 * them (unknowns, the concretizations, the prerequisites of the states) by the value as the writer wrote it, whole-token only.
 * Nothing is looked for by shape: the address is the one the writer named.
 */
export function recordPlaces(record: unknown, catalog: unknown, source: string, bed: string): RecordPlace[] {
  const key = addressKey(source);
  if (key === null || !isRecord(record)) return [];
  const ledgers = isRecord(record.ledgers) ? record.ledgers : {};
  const places: RecordPlace[] = [];
  let grammar: ReturnType<typeof compileGrammar> | undefined;
  for (const [i, row] of (Array.isArray(ledgers.adapted) ? ledgers.adapted : []).entries()) {
    if (!isRecord(row) || !Array.isArray(row.commands)) continue;
    for (const [j, line] of row.commands.entries()) {
      if (typeof line !== 'string') continue;
      grammar ??= compileGrammar(commandDefinitions(catalog));
      const identity = identityOf(commandIdentity(grammar, line));
      const hit = identity?.parameters.find((p) => p.parsed.kind === 'address' && (p.parsed.value.kind === 'ipv4' || p.parsed.value.kind === 'ipv6') && addressKey(String(p.parsed.value.value)) === key);
      if (!hit) continue;
      const fixed = addressKey(bed) === null ? line : line.replace(token(hit.raw), bed);
      places.push({ how: 'command', at: `/ledgers/adapted/${i}/commands/${j}`, ...(typeof row.atom === 'string' ? { atom: row.atom } : {}), text: line, ...(fixed !== line ? { fixed } : {}) });
    }
  }
  const sentences: Array<{ at: string; label: string; text: string }> = [];
  for (const [k, row] of (Array.isArray(record.unknowns) ? record.unknowns : []).entries())
    if (isRecord(row)) for (const field of ['missing', 'next_action']) if (typeof row[field] === 'string') sentences.push({ at: `/unknowns/${k}/${field}`, label: `unknowns 第 ${k + 1} 条`, text: row[field] });
  for (const [k, row] of (Array.isArray(ledgers.concretizations) ? ledgers.concretizations : []).entries())
    if (isRecord(row) && typeof row.value === 'string') sentences.push({ at: `/ledgers/concretizations/${k}/value`, label: `具体化第 ${k + 1} 条${typeof row.slot === 'string' ? `（${row.slot}）` : ''}`, text: row.value });
  const states = isRecord(record.sources) && Array.isArray(record.sources.states) ? record.sources.states : [];
  for (const [k, row] of states.entries())
    if (isRecord(row) && Array.isArray(row.prerequisites)) for (const [m, text] of row.prerequisites.entries()) if (typeof text === 'string') sentences.push({ at: `/sources/states/${k}/prerequisites/${m}`, label: `${typeof row.atom === 'string' ? row.atom : `第 ${k + 1} 条`} 的前置`, text });
  const written = token(source.trim());
  for (const sentence of sentences) {
    written.lastIndex = 0;
    const found = written.exec(sentence.text);
    if (found) places.push({ how: 'sentence', at: sentence.at, label: sentence.label, text: excerpt(sentence.text, found.index, found[0].length) });
  }
  return places;
}

/**
 * The text of the refusal of one replacement row whose source is no address of the author's commands. `allowed` are the addresses
 * the rule accepts as a source, as their texts. The plan's `replacements` row is shown as written; the next step is the correct
 * form, which names the bed address of the row and, when the record holds the address in an adapted command, that command with
 * the bed address in its place.
 */
export function replacementSourceText(input: { replacement: { case: string; bed: string }; index: number; allowed: readonly string[]; record: unknown; catalog: unknown }): string {
  const { replacement, index, allowed } = input, source = replacement.case, bed = replacement.bed;
  const places = recordPlaces(input.record, input.catalog, source, bed);
  const commands = places.filter((place) => place.how === 'command'), sentences = places.filter((place) => place.how === 'sentence');
  const documentation = isDocumentationAddress(source);
  const also = [`替换表只收锁定命令树从作者原文命令里解析出的地址参数（这里解析出 ${allowed.length} 个），不按外形从散文里找地址`];
  if (commands.length) {
    const shown = commands.slice(0, 2).map((place) => `作者动作 ${place.atom ?? '（记录没标）'} 的改写命令「${place.text}」（${place.at}）`);
    also.push(`${source} 出自重组记录：${shown.join('；')}${commands.length > 2 ? `；另有 ${commands.length - 2} 处` : ''}${documentation ? '；重组按规则在命令语法必填 IP 而原句没定值时写文档保留地址占位，待脚本编写按测试环境替换' : ''}`);
  }
  if (sentences.length) {
    const place = sentences[0]!;
    also.push(commands.length ? `重组记录的文字里也写了它：${place.label}（${place.at}）写着「${place.text}」` : `${source} 出自重组记录：${place.label}（${place.at}）写着「${place.text}」，只在文字里，不在任何改写命令里`);
  }
  const bedText = addressKey(bed) === null ? '把测试环境清单里的地址' : `把测试环境清单里的地址 ${bed} `;
  const next = commands.length
    ? `删掉这一行；${bedText}直接写进计划里原来写 ${source} 的步骤命令${commands[0]!.fixed !== undefined ? `（该改写命令在计划里写成「${commands[0]!.fixed}」）` : ''}；replacements 只留作者原文命令里的地址，没有就写 []`
    : sentences.length
      ? `删掉这一行；${bedText}直接写进计划里用到这个地址的步骤命令的地址参数；replacements 只留作者原文命令里的地址，没有就写 []`
      : '删掉这一行；计划里要用的测试环境地址直接写进步骤命令；replacements 只留作者原文命令里的地址（上面「允许」里的），没有就写 []';
  return refusalText({
    what: `替换的来源 ${source} 不是作者命令里的地址${places.length ? `，是重组记录里${documentation ? '暂用的文档保留地址' : '写到的地址'}` : ''}`,
    place: `${PLAN_DATA}/replacements/${index}`,
    seen: shownValue({ case: source, bed }),
    allowed,
    also,
    next,
  });
}
