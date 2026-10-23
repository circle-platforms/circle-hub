// quote@1: every quotation appears verbatim in the fragment its reference resolves to. White space differences only are
// ignored; the rule is quoteMatches in text.ts and must agree with hub/refs (shared vectors: quote-vectors.json).
import { QuoteTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { getAt, joinPointer, selectAll } from '../json.ts';
import { baseFor, isReferenceUri, quoted, refuteProtocol, support, unknown } from '../outcome.ts';
import { collapseWhitespace, quoteInCollapsed } from '../text.ts';
import { defineInterpreter, pathIssues } from './define.ts';

export const quoteInterpreter = defineInterpreter({
  id: 'quote@1',
  codes: ['QUOTE_MISMATCH'],
  schema: QuoteTable,
  check: (table) => pathIssues(table.quotes.map((q, i): [string, string] => [`/quotes/${i}/select`, q.select])),
  run(table, request) {
    const base = baseFor(request.subject, table);
    const outcomes: CheckOutcome[] = [];
    // A fragment can be megabytes and quoted many times: collapse it once per run.
    const collapsed = new Map<string, string>();
    for (const rule of table.quotes) {
      for (const selected of selectAll(request.subject, rule.select) ?? []) {
        const text = getAt(selected.value, rule.text);
        const reference = getAt(selected.value, rule.reference);
        const pointer = joinPointer(selected.pointer, rule.text);
        if (!text.found || typeof text.value !== 'string' || !reference.found || !isReferenceUri(reference.value)) {
          outcomes.push(unknown(base, 'missing_input', `${selected.pointer} 的引文缺少原文或有效的引用`, { pointer: selected.pointer }));
          continue;
        }
        const ref = reference.value;
        const fragment = request.sources?.text(ref);
        if (fragment === undefined) {
          // The graded view says why: not an input (the model can fix the reference) and no such fragment (fix the
          // selector or the quote) are refutations; only genuinely unreadable sources stay unknown, honestly.
          const why = request.sources?.why?.(ref);
          const unread = request.sources?.unread?.(ref);
          if (unread?.reason === 'credential_unreadable' || why === 'retain_only') {
            const failure = unread ?? {reason:'credential_unreadable', missing_fact:'管理员尚未接受此来源', next_action:'请求管理员接受来源，接受后重新核验'};
            outcomes.push(unknown(base,'awaiting_step',`引用 ${ref} 的源文件含凭据，原文不可读；缺少的事实：${failure.missing_fact}；下一步：${failure.next_action}`,{
              pointer, grounds:[ref], data:{unread_sources:[{reference:ref,...failure}],missing_fact:failure.missing_fact,next_action:failure.next_action},
            }));
          }
          else if (why === 'not_bound') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', `引用 ${ref} 的源文件不是这次运行的输入`, { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'no_fragment') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', `引用 ${ref} 的片段不存在`, { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'too_large') outcomes.push(unknown(base, 'missing_input', `引用 ${ref} 的片段超过大小上限`, { pointer, grounds: [ref] }));
          else if (why === 'unavailable') outcomes.push(unknown(base, 'missing_input', `引用 ${ref} 的源文件取不回`, { pointer, grounds: [ref] }));
          else outcomes.push(unknown(base, 'missing_input', `引用 ${ref} 没有绑定到本次运行，无法核对引文`, { pointer, grounds: [ref] }));
          continue;
        }
        const data = { quote: text.value, reference: ref };
        let haystack = collapsed.get(ref);
        if (haystack === undefined) {
          haystack = collapseWhitespace(fragment);
          collapsed.set(ref, haystack);
        }
        // Same rule as quoteMatches(fragment, quote), with the fragment side computed once.
        if (quoteInCollapsed(haystack, text.value)) outcomes.push(support(base, `引文 ${quoted(text.value)} 与所引片段逐字一致`, { pointer, grounds: [ref], data }));
        else {
          const why = collapseWhitespace(text.value) === '' ? '引文为空' : `所引片段里没有 ${quoted(text.value)}`;
          outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', why, { pointer, grounds: [ref], data }));
        }
      }
    }
    if (outcomes.length === 0) outcomes.push(support(base, '没有需要核对的引文', { data: { checked: 0 } }));
    return outcomes;
  },
});
