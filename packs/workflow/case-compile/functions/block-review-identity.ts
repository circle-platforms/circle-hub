// Content-addressed proof identities, stable between a public run summary and the private frozen source bindings.
import { isRecord } from './text.ts';
function ref(value: unknown): string | null { if (typeof value === 'string')
    return value; if (isRecord(value) && isRecord(value.meta) && typeof value.meta.record === 'string')
    return 'rec:' + value.meta.record; return null; }
export function blockReviewIdentity(value: unknown): {
    run: string;
    result: string;
} | null { if (!isRecord(value))
    return null; const run = ref(value.run), result = ref(value.result); return run && result ? { run, result } : null; }
export function blockReviewSources(sources: unknown): {
    run: string;
    result: string;
} | null { if (!Array.isArray(sources))
    return null; const one = (slot: string) => { const rows = sources.filter(v => isRecord(v) && v.slot === slot); return rows.length === 1 && isRecord(rows[0]) ? rows[0].reference : null; }; return blockReviewIdentity({ run: one('criteria_review_run'), result: one('criteria_review') }); }
