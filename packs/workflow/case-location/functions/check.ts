// The locate check (pack function, applies run): one outcome per item. Support when the tree gives the product line and a
// consistent version level, its data the whole answer (every outcome becomes a fact claim); unknown (missing input) where the
// scheme cannot answer, its data what is known; refute on a contradictory version level or when a declaration of the caller
// contradicts the tree. Never a violation for an uncertain answer. The ground is the item's location (its mind-map node); the
// folder facts are not in that node but in the system pack's metadata, copied into the item's fields, so each outcome also
// points at those fields in the subject (`/items/<k>/fields`, the k-th item of the run record as well).
import { emptyAnswer, locateInputOf, locateItem } from './locate.ts';
import { guarded, internalError, isRecord, isReference } from './text.ts';
import type { CheckOutcome, LocateAnswer } from './types.ts';

const TIER = 'advisory' as const;

function outcomeOf(id: string, at: number, location: unknown, answer: LocateAnswer, judgment: ReturnType<typeof locateItem>['judgment']): CheckOutcome {
  const grounds = isReference(location) ? [location] : [];
  const data = answer as unknown as Record<string, unknown>;
  const common = { statement: judgment.statement, grounds, tier: TIER, item: id, pointer: `/items/${at}/fields`, data };
  if (judgment.verdict === 'refute') return { verdict: 'refute', code: judgment.code, ...common };
  if (judgment.verdict === 'unknown') return { verdict: 'unknown', missing: '当前条目的定位事实：' + (answer.missing.join('、') || judgment.brief), reason: judgment.reason, ...common };
  return { verdict: 'support', ...common };
}

/** Outcomes of the check for a subject of the subject builder (functions/subject.ts). */
export function locateOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const out: CheckOutcome[] = [];
  for (const [at, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
    const id = item.id;
    try {
      const { answer, judgment } = locateItem(locateInputOf(id, item.fields, context));
      out.push(outcomeOf(id, at, item.location, answer, judgment));
    } catch (error) {
      const message = internalError(error);
      out.push(outcomeOf(id, at, item.location, emptyAnswer(id, message), { verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`定位出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `定位出错（任务包缺陷）：${message}`, brief: '定位出错' }));
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('定位检查的被判对象里没有条目（子对象构建函数没有给出 items）'), reason: 'check_error', statement: '定位检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function locateCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => locateOutcomes(isRecord(input) ? input.subject : undefined),
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`定位检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `定位检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
