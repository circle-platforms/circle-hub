// Subject builder of the coverage check (checks.json `coverage`, tables/template-v3-coverage.json, coverage@1): from the
// fields of one document item it lists the categories some case shows and the declared skips. The members that must be
// covered are the table's closed set, so the item cannot decide what is required. Built from the item fields only; a
// category list that is not there leaves `covered` absent, so the check says unknown (missing input) instead of judging [].
// No totality guard: the engine treats only a throw as a failed builder (unknown, check_error, cause in the admin log); a
// refusal object returned here would be judged as a subject without input.
import { isRecord } from './common.ts';
import type { CoverageSubject } from './types.ts';

export function coverageSubject(input: unknown): CoverageSubject {
  const item = isRecord(input) && isRecord(input.item) ? input.item : {};
  const fields = isRecord(item.fields) ? item.fields : {};
  const out: CoverageSubject = {
    item: typeof item.id === 'string' ? item.id : null,
    location: typeof item.location === 'string' ? item.location : null,
    document: typeof fields.document === 'string' ? fields.document : null,
    skipped: [],
  };
  if (Array.isArray(fields.categories)) {
    out.covered = fields.categories.filter(isRecord).filter((category) => typeof category.id === 'string' && category.present === true).map((category) => category.id as string);
  }
  if (Array.isArray(fields.skipped)) {
    for (const skip of fields.skipped) {
      if (isRecord(skip) && typeof skip.category === 'string' && typeof skip.reason === 'string') out.skipped.push({ category: skip.category, reason: skip.reason });
    }
  }
  return out;
}

export default function (input: unknown): unknown {
  return coverageSubject(input);
}
