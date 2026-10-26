// catalog@1: command phrases and membership statements against the bound catalog (C07). Heads are found by longest match;
// arguments are checked against the overloads with typed parameters. Absence is a fact only for a catalog declared complete.
// On a negative case the refutations stay refutations: outcomes are marked and get the negative tier, the caller compares.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { CatalogTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { matchSignatures, type SignatureResult } from '../catalog/signature.ts';
import { splitWords, tokenize } from '../catalog/tokenize.ts';
import type { CatalogView } from '../catalog/view.ts';
import { getAt, locate } from '../json.ts';
import { baseFor, quoted, refute, support, unknown, type OutcomeBase } from '../outcome.ts';
import { normalizeText } from '../text.ts';
import type { TableIssue } from '../types.ts';
import { basisIssue, defineInterpreter, pathIssues } from './define.ts';
import { missingNote } from './values.ts';

export const CATALOG_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'catalog');

function semantic(table: CatalogTable): TableIssue[] {
  const issues: TableIssue[] = pathIssues([
    ...(table.commands ?? []).map((p, i): [string, string] => [`/commands/${i}`, p]),
    ['/claims/select', table.claims?.select],
  ]);
  if (!table.commands?.length && !table.claims) issues.push({ path: '', message: '表至少要给出 commands 或 claims 之一' });
  table.negative?.expect.forEach((code, i) => {
    if (!(CATALOG_CODES as string[]).includes(code)) issues.push({ path: `/negative/expect/${i}`, message: `catalog@1 不会给出 ${code}；可期望的码：${CATALOG_CODES.join('、')}` });
  });
  issues.push(...basisIssue('/negative/tier', table.negative?.tier, table.basis));
  return issues;
}

const arityText = (arities: { min: number; max: number }[]): string =>
  `${arities.map((a) => (a.min === a.max ? `${a.min}` : `${a.min} 到 ${a.max}`)).join('、')} 个`;

/** Why arguments after a head fit none of its signatures, for statements. */
function misfit(result: Exclude<SignatureResult, { kind: 'match'|'unchecked' }>, args: readonly string[]): string {
  if (result.kind === 'arity') return `有 ${args.length} 个参数，签名要求 ${arityText(result.arities)}`;
  const first = result.best.violations[0];
  return `参数 ${first.param} 取值 ${quoted(first.value)}，应为${first.expected}`;
}

/** Whether a command exists: its words are a head or a menu, or a head followed by arguments that fit one of its signatures. */
function membership(catalog: CatalogView, tokens: string[], fold: boolean, strictSignatures=false) {
  const lookup = { caseSensitive: !fold };
  const exact = catalog.get(tokens, lookup);
  if (exact && !strictSignatures) return { exists: true, grounds: [exact.reference], head: exact.words.join(' ') } as const;
  if (!strictSignatures && catalog.hasPrefix(tokens, lookup)) return { exists: true, grounds: catalog.reference ? [catalog.reference] : [], head: undefined } as const;
  const match = catalog.lookup(tokens, lookup);
  if (!match) return { exists: false, grounds: catalog.reference ? [catalog.reference] : [], head: undefined } as const;
  const head = match.entry.words.join(' ');
  const args = tokens.slice(match.length);
  const result = matchSignatures(match.entry, args, fold);
  if (result.kind === 'match') {
    const grounds = [match.entry.reference, ...(result.best.signature.reference ? [result.best.signature.reference] : [])];
    return { exists: true, grounds, head } as const;
  }
  if(result.kind==='unchecked')return {exists:null,grounds:[match.entry.reference],head,unchecked:result.best.unchecked} as const;
  // The head exists but the rest fits no signature: the absence rests on the head entry and on the catalog as a whole.
  return { exists: false, grounds: [match.entry.reference, ...(catalog.reference ? [catalog.reference] : [])], head, misfit: misfit(result, args) } as const;
}

export const catalogInterpreter = defineInterpreter({
  id: 'catalog@1',
  codes: CATALOG_CODES,
  schema: CatalogTable,
  check: semantic,
  run(table, request) {
    const subject = request.subject;
    const base = baseFor(subject, table);
    const catalog = request.catalog;
    if (!catalog) return [unknown(base, 'missing_input', `没有绑定目录 ${table.catalog}`)];
    const negative = table.negative !== undefined && getAt(subject, table.negative.flag).value === true;
    const phraseBase: OutcomeBase = negative ? { ...base, tier: table.negative?.tier ?? 'advisory' } : base;
    const fold = !catalog.caseSensitive || table.match?.case === 'insensitive';
    const lookup = { caseSensitive: !fold };
    const scope = table.scope ?? 'resolved';
    const catalogGrounds = catalog.reference ? [catalog.reference] : [];
    const normalized = (text: string): string => normalizeText(text, { unicode: table.match?.unicode ?? 'nfc', whitespace: 'trim' });
    const words = (text: string): string[] | null => tokenize(normalized(text), table.quotes ?? true);
    const phraseOutcomes: CheckOutcome[] = [];
    const claimOutcomes: CheckOutcome[] = [];
    const missing: string[] = [];
    let skipped = 0;

    for (const path of table.commands ?? []) {
      const located = locate(subject, path);
      if (located.missing) {
        if (table.required === true) phraseOutcomes.push(unknown(phraseBase, 'missing_input', `被判对象里没有 ${path}（缺失，不同于空列表）`));
        else missing.push(path);
        continue;
      }
      for (const selected of located.selected) {
        const phrases =
          typeof selected.value === 'string'
            ? [{ pointer: selected.pointer, text: selected.value as unknown }]
            : Array.isArray(selected.value)
              ? selected.value.map((text, i) => ({ pointer: `${selected.pointer}/${i}`, text: text as unknown }))
              : undefined;
        if (!phrases) {
          phraseOutcomes.push(unknown(phraseBase, 'check_error', `${selected.pointer} 不是命令文本`, { pointer: selected.pointer }));
          continue;
        }
        for (const { pointer, text } of phrases) {
          if (typeof text !== 'string') {
            phraseOutcomes.push(unknown(phraseBase, 'check_error', `${pointer} 不是字符串`, { pointer }));
            continue;
          }
          const tokens = words(text);
          // Out-of-scope phrases are not verdicts (V01 R[0]): the head decides the scope, also for text that cannot be split.
          const head = tokens ?? splitWords(normalized(text));
          if (head.length === 0) {
            skipped += 1;
            continue;
          }
          const match = catalog.lookup(head, lookup);
          if (!match && !(scope === 'all' || (scope === 'first_word' && catalog.hasPrefix([head[0]], lookup)))) {
            skipped += 1;
            continue;
          }
          if (tokens === null) {
            phraseOutcomes.push(unknown(phraseBase, 'check_error', `无法切分 ${quoted(text)}：引号不成对或以反斜杠结尾`, { pointer }));
            continue;
          }
          const command = tokens.join(' ');
          if (!match) {
            phraseOutcomes.push(
              catalog.complete
                ? refute(phraseBase, 'core.catalog.not_member', `${quoted(command)} 在目录里找不到对应的命令`, { pointer, grounds: catalogGrounds, data: { command } })
                : unknown(phraseBase, 'integrity_unproven', `${quoted(command)} 不在目录里，但目录没有声明完备，不能断定它不存在`, { pointer, grounds: catalogGrounds, data: { command } }),
            );
            continue;
          }
          const headText = match.entry.words.join(' ');
          const args = tokens.slice(match.length);
          const result = matchSignatures(match.entry, args, fold);
          const grounds = [match.entry.reference];
          if (result.kind === 'arity') {
            phraseOutcomes.push(
              refute(phraseBase, 'core.catalog.arity_mismatch', `${quoted(command)} 有 ${args.length} 个参数，“${headText}”的签名要求 ${arityText(result.arities)}`, {
                pointer,
                grounds,
                data: { command, head: headText, arguments: args.length, arities: result.arities },
              }),
            );
            continue;
          }
          const { best } = result;
          if (best.signature.reference) grounds.push(best.signature.reference);
          const data = { command, head: headText, overload: best.overload, signature: best.signature.id ?? null, arguments: best.bindings };
          if(result.kind==='unchecked'){
            phraseOutcomes.push({...unknown(phraseBase,best.unchecked[0].constraint.reason,`${quoted(command)} 的参数约束未核对；${best.unchecked.map(gap=>gap.constraint.next_action).join('；')}`,{pointer,grounds,data:{...data,unchecked_constraints:best.unchecked}}),missing:[...new Set(best.unchecked.map(gap=>gap.constraint.missing))].join('；')});
          } else if (result.kind === 'violations') {
            const first = best.violations[0];
            phraseOutcomes.push(
              refute(phraseBase, first.code, `${quoted(command)} 的参数 ${first.param} 取值 ${quoted(first.value)}，应为${first.expected}`, {
                pointer,
                grounds,
                data: { ...data, violations: best.violations },
              }),
            );
          } else {
            phraseOutcomes.push(support(phraseBase, `${quoted(command)} 与目录中“${headText}”的签名一致`, { pointer, grounds, data }));
          }
        }
      }
    }

    if (table.claims) {
      const claims = table.claims;
      // Statements are optional: a missing location means there are none.
      for (const selected of locate(subject, claims.select).selected) {
        const commandFound = getAt(selected.value, claims.command);
        const presentFound = getAt(selected.value, claims.present);
        const pointer = selected.pointer;
        if (!commandFound.found || typeof commandFound.value !== 'string' || !presentFound.found || typeof presentFound.value !== 'boolean') {
          claimOutcomes.push(unknown(base, 'missing_input', `${pointer} 的陈述缺少命令文本或“是否存在”`, { pointer }));
          continue;
        }
        const tokens = words(commandFound.value);
        if (tokens === null || tokens.length === 0) {
          claimOutcomes.push(unknown(base, 'check_error', `无法切分 ${quoted(commandFound.value)}`, { pointer }));
          continue;
        }
        const command = tokens.join(' ');
        const claimsPresent = presentFound.value;
        const found = membership(catalog, tokens, fold,table.strict_signatures===true);
        const grounds = [...found.grounds];
        const data = { command, claims_present: claimsPresent, in_catalog: found.exists, ...(found.head !== undefined ? { head: found.head } : {}) };
        const why = 'misfit' in found && found.misfit ? `（有命令“${found.head}”，但${found.misfit}）` : '';
        if(found.exists===null){
          claimOutcomes.push({...unknown(base,found.unchecked[0].constraint.reason,`尚未核对 ${quoted(command)} 的参数约束，不能据此判断存在或不存在`,{pointer,grounds,data:{...data,unchecked_constraints:found.unchecked}}),missing:[...new Set(found.unchecked.map(gap=>gap.constraint.missing))].join('；')});
        } else if (found.exists && claimsPresent) claimOutcomes.push(support(base, `目录里有 ${quoted(command)}，与陈述一致`, { pointer, grounds, data }));
        else if (found.exists) {
          claimOutcomes.push(refute(base, 'core.catalog.membership_contradicted', `陈述说 ${quoted(command)} 不存在，目录里有这个命令`, { pointer, grounds, data }));
        } else if (!catalog.complete) {
          claimOutcomes.push(unknown(base, 'integrity_unproven', `目录里没有 ${quoted(command)}${why}，但目录没有声明完备，不能断定它不存在`, { pointer, grounds, data }));
        } else if (claimsPresent) {
          claimOutcomes.push(refute(base, 'core.catalog.membership_contradicted', `陈述说 ${quoted(command)} 存在，目录里没有这个命令${why}`, { pointer, grounds, data }));
        } else {
          claimOutcomes.push(support(base, `目录里没有 ${quoted(command)}${why}，与陈述一致`, { pointer, grounds, data }));
        }
      }
    }

    if (phraseOutcomes.length === 0 && claimOutcomes.length === 0) {
      const note = missingNote(missing);
      phraseOutcomes.push(support(phraseBase, `没有需要按目录核对的命令（跳过 ${skipped} 条）${note.text}`, { data: { checked: 0, skipped, ...note.data } }));
    }
    if (negative && table.negative) {
      const expect = table.negative.expect;
      for (const outcome of phraseOutcomes) {
        outcome.data = { ...outcome.data, negative_case: true, expected: outcome.verdict === 'refute' && outcome.code !== undefined && expect.includes(outcome.code) };
      }
    }
    return [...phraseOutcomes, ...claimOutcomes];
  },
});
