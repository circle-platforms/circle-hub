// membership@1: every selected value belongs to a closed set given by value, by reference or by the name of a pack set.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { MembershipTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { baseFor, quoted, refute, support, unknown } from '../outcome.ts';
import { normalizeText } from '../text.ts';
import { defineInterpreter, pathIssues } from './define.ts';
import { missingNote, resolveSet, scalarText, selectLocations } from './values.ts';

export const MEMBERSHIP_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'membership');

export const membershipInterpreter = defineInterpreter({
  id: 'membership@1',
  codes: MEMBERSHIP_CODES,
  schema: MembershipTable,
  check: (table) => pathIssues(table.values.map((p, i): [string, string] => [`/values/${i}`, p])),
  run(table, request) {
    const base = baseFor(request.subject, table);
    const set = resolveSet(table.set, request);
    if (!set.ok) return [unknown(base, set.reason, set.detail)];
    const grounds = set.ground ? [set.ground] : [];
    const members = new Set(set.values.map((v) => normalizeText(v, table.match)));
    const { values: selected, missing } = selectLocations(request.subject, table.values);
    const outcomes: CheckOutcome[] = [];
    // Missing is not empty (C04 R[4]): a required location that is missing is unknown; an empty list is nothing to check.
    if (table.required === true) for (const path of missing) outcomes.push(unknown(base, 'missing_input', `被判对象里没有 ${path}（缺失，不同于空列表）`));
    if (selected.length === 0 && outcomes.length === 0) {
      const note = missingNote(missing);
      return [support(base, `没有需要核对的取值${note.text}`, { data: { checked: 0, ...note.data } })];
    }
    for (const { pointer, value } of selected) {
      const text = scalarText(value);
      if (text === undefined) {
        outcomes.push(unknown(base, 'check_error', `${pointer} 不是字符串或数值`, { pointer }));
        continue;
      }
      const normalized = normalizeText(text, table.match);
      if (members.has(normalized)) {
        outcomes.push(support(base, `${quoted(text)} 在封闭集合里`, { pointer, grounds, data: { value: text } }));
      } else {
        const allowed = set.values.slice(0, 20);
        outcomes.push(
          refute(base, 'core.membership.not_in_set', `${quoted(text)} 不在 ${set.values.length} 个声明的取值里（${allowed.join('、')}${set.values.length > 20 ? '…' : ''}）`, {
            pointer,
            grounds,
            data: { value: text, allowed },
          }),
        );
      }
    }
    return outcomes;
  },
});
