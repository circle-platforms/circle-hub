// quote@1: every quotation is an exact contiguous substring of the decoded fragment its reference resolves to.
// The rule is quoteMatches in text.ts and must agree with hub/refs (shared vectors: quote-vectors.json).
import { QuoteTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { getAt, joinPointer, selectAll } from '../json.ts';
import { baseFor, isReferenceUri, quoted, refuteProtocol, support, unknown } from '../outcome.ts';
import { collapseWhitespace, quoteMatches } from '../text.ts';
import { defineInterpreter, pathIssues } from './define.ts';

export const quoteInterpreter = defineInterpreter({
  id: 'quote@1',
  codes: ['QUOTE_MISMATCH'],
  schema: QuoteTable,
  check: (table) => pathIssues(table.quotes.map((q, i): [string, string] => [`/quotes/${i}/select`, q.select])),
  run(table, request) {
    const base = baseFor(request.subject, table);
    const outcomes: CheckOutcome[] = [];
    for (const rule of table.quotes) {
      for (const selected of selectAll(request.subject, rule.select) ?? []) {
        const text = getAt(selected.value, rule.text);
        const reference = getAt(selected.value, rule.reference);
        const pointer = joinPointer(selected.pointer, rule.text);
        if (!text.found || typeof text.value !== 'string' || !reference.found || typeof reference.value !== 'string') {
          outcomes.push(unknown(base, 'missing_input', `${selected.pointer} 的引文缺少原文或有效的引用，请补写引文文字及引用后重交`, { pointer: selected.pointer }));
          continue;
        }
        const ref = reference.value;
        if (!isReferenceUri(ref)) {
          outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', '引用写法不对，请使用 src:<摘要>、tree:<根>/<路径>@<条目> 或 rec:<记录>#/<字段>', { pointer, data: { quote: text.value, reference: ref, why: 'malformed' } }));
          continue;
        }
        const fragment = request.sources?.text(ref);
        if (fragment === undefined) {
          // Decision 36: permanent reference defects refute; withheld or temporarily unavailable bytes need evidence.
          const why = request.sources?.why?.(ref);
          const unread = request.sources?.unread?.(ref);
          if (unread?.reason === 'credential_unreadable' || why === 'retain_only') {
            const failure = unread ?? {reason:'credential_unreadable', missing_fact:'管理员尚未接受此来源', next_action:'请求管理员接受来源，接受后重新核验'};
            outcomes.push(unknown(base,'awaiting_step',`引用 ${ref} 的源文件含凭据，原文不可读；缺少的事实：${failure.missing_fact}；下一步：${failure.next_action}；接受后重评`,{
              pointer, grounds:[ref], missing: failure.missing_fact, data:{unread_sources:[{reference:ref,...failure}],missing_fact:failure.missing_fact,next_action:failure.next_action},
            }));
          }
          else if (why === 'not_bound') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', `引用 ${ref} 的源文件不是这次运行的输入，请改引本运行已绑定的输入（src:<摘要> 或 tree:<锁定根>/<路径>@<条目>）`, { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'not_groundable') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', request.sources?.rule?.(ref) ?? '这类记录不能作根据（B01 R[4]），请改引结果、动作或效果记录', { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'entry_unaddressed') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', '知识条目不能单独作根据（B01 R[5]），请改写为 tree:<根>/<路径>@<条目>', { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'malformed') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', '引用写法不对，请使用 src:<摘要>、tree:<根>/<路径>@<条目> 或 rec:<记录>#/<字段>', { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'no_fragment') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', `引用 ${ref} 的片段不存在`, { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'too_large') outcomes.push(refuteProtocol(base, 'QUOTE_MISMATCH', `引用 ${ref} 的片段超过大小上限，请改引更小的片段`, { pointer, grounds: [ref], data: { quote: text.value, reference: ref, why } }));
          else if (why === 'integrity_unproven') outcomes.push(unknown(base, 'integrity_unproven', `引用 ${ref} 的完整性未证明；缺与摘要一致的可信原文，请管理员从可信备份恢复记录或原始字节后重新核验`, { pointer, grounds: [ref], data: { why } }));
          else if (why === 'unavailable') outcomes.push(unknown(base, 'missing_input', `引用 ${ref} 的源文件暂时取不回；缺该片段的可读原文，请重读后重评`, { pointer, grounds: [ref], missing: `引用 ${ref} 的可读片段原文`, data: { why } }));
          else outcomes.push(unknown(base, 'missing_input', `引用 ${ref} 的片段尚未读到；缺片段原文，请重新读取并重评`, { pointer, grounds: [ref], missing: `引用 ${ref} 的片段原文`, data: { why: 'unavailable' } }));
          continue;
        }
        const data = { quote: text.value, reference: ref };
        if (quoteMatches(fragment, text.value)) outcomes.push(support(base, `引文 ${quoted(text.value)} 与所引片段逐字一致`, { pointer, grounds: [ref], data }));
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
