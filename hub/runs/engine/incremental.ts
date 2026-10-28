// Generic first-material accounting. No workflow content, semantic statuses or clock ordering is inferred here.
import { canonicalize } from '../../records/api.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { isReason } from '../../../contracts/generated/vocabulary.ts';
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown) => Array.isArray(v) && v.length > 0;
export function firstDeclarationGrowth(previous: unknown, current: unknown): boolean {
    try {
        if (!object(current) || !Array.isArray(current.items) || !current.items.length)
            return false;
        const valid = (rows: any[]) => rows.every(r => object(r) && typeof r.item === 'string' && r.handling === 'handled' && object(r.slots)) && new Set(rows.map(r => r.item)).size === rows.length;
        if (!valid(current.items))
            return false;
        if (previous === null)
            return true;
        if (!object(previous) || !Array.isArray(previous.items) || !valid(previous.items))
            return false;
        const { items: _p, ...oldHeader } = previous, { items: _c, ...newHeader } = current;
        if (canonicalize(oldHeader) !== canonicalize(newHeader) || previous.items.length !== current.items.length)
            return false;
        const before = new Map(previous.items.map(r => [r.item, r]));
        let grew = false;
        for (const row of current.items) {
            const old = before.get(row.item);
            if (!old)
                return false;
            const { slots: _old, ...oldIdentity } = old, { slots: _new, ...newIdentity } = row;
            if (canonicalize(oldIdentity) !== canonicalize(newIdentity))
                return false;
            for (const [key, value] of Object.entries(old.slots))
                if (nonempty(value) && canonicalize(value) !== canonicalize(row.slots[key]))
                    return false;
            for (const [key, value] of Object.entries(row.slots)) {
                if (!Array.isArray(value))
                    return false;
                if (nonempty(value) && !nonempty(old.slots[key]))
                    grew = true;
            }
        }
        return grew;
    }
    catch {
        return false;
    }
}
export function unknownOnlyRequirement(result: ValidationResult, key: string): boolean {
    if (result.acceptance !== 'accepted')
        return false;
    const errors = result.errors.filter(e => e.requirement === key);
    if (!errors.length || errors.some(e => !isReason(e.code)))
        return false;
    for (const item of Object.values(result.partitions).flat())
        for (const requirement of item.requirements)
            if (requirement.requirement === key && (requirement.status === 'unsatisfied' || requirement.layers.some(l => l.terminal === 'violation')))
                return false;
    return !result.cross_item.some(c => c.requirement === key && c.statement.verdict === 'refute');
}
