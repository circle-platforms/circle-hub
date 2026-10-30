// Genuine, complete Hub envelopes only. Uploaded JSON is never an admission credential.
import { isRecord } from './text.ts';
import { canonicalJson } from './canonical-json.ts';
import T from '../tables/recompose-format.json' with { type: 'json' };
export const object = (value: any): boolean => isRecord(value);
export function envelope(bound: any, kind: string): any | null { return object(bound) && bound.external === null && bound.meta?.kind === kind && typeof bound.meta.record === 'string' && bound.meta.pointer === undefined && bound.model?.kind === kind && object(bound.model.body) ? { body: bound.model.body, reference: 'rec:' + bound.meta.record } : null; }
export function acceptedPair(runInput: any, resultInput: any, pack: string): {
    run: any;
    result: any;
    reference: string;
} | null { const r = envelope(runInput, 'run'), v = envelope(resultInput, 'validation_result'); if (!r || !v || r.body.pack !== pack + '@1.0.1' || v.body.schema !== 'validation@1' || v.body.run !== r.body.run || v.body.acceptance !== 'accepted' || v.body.locks?.pack !== r.body.pack || v.body.locks?.pack_digest !== r.body.pack_digest)
    return null; return { run: r.body, result: v.body, reference: v.reference }; }
export function satisfied(result: any, key: string, item?: string) { const rows = item === undefined ? result.cross_item ?? [] : Object.values(result.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((v: any) => v.item === item)?.requirements?.find((r: any) => r.requirement === key)?.claims ?? []; if (item !== undefined) {
    const row = Object.values(result.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((v: any) => v.item === item)?.requirements?.find((r: any) => r.requirement === key);
    return row?.status === 'satisfied';
} return rows.some((c: any) => c.requirement === key && c.statement?.verdict === 'support' && c.validity?.status === 'valid'); }
export function authorityOf(runInput: any, resultInput: any, context: any): any | null { const p = acceptedPair(runInput, resultInput, T.packs.authority); if (!p || !satisfied(p.result, 'authority'))
    return null; const authority = p.run.groups?.find((g: any) => g.kind === T.product)?.authority; if (!authority || authority.scope.product !== context.product || authority.scope.product_pack_digest !== context.product_pack_digest || authority.scope.line !== context.line || authority.scope.root !== context.root)
    return null; return { ...authority, receipt: p.reference }; }
export function reviewSubject(record: any, atom: string) { return { case: record.case, atom: record.atoms?.find((a: any) => a.id === atom) ?? null, contract: record.contract, expectation_slots: record.expectation_slots, governing: record.sources?.governing, candidates: record.sources?.candidates, adapted: record.ledgers?.adapted?.filter((a: any) => a.atom === atom), concretizations: record.ledgers?.concretizations }; }
export function reviewedAtom(record: any, atom: string, runInput: any, resultInput: any, sourceRun: string | null, scope: any): any | null { const p = acceptedPair(runInput, resultInput, T.packs.review); if (!p)
    return null; const item = p.run.items?.find((i: any) => i.fields?.scope?.product === scope.product && i.fields?.scope?.root === scope.root && i.fields?.scope?.product_pack_digest === scope.product_pack_digest && i.fields?.atom === atom && canonicalJson(i.fields.subject) === canonicalJson(reviewSubject(record, atom))); if (!item || p.run.predecessor !== item.fields.author_run || sourceRun !== p.run.predecessor || !satisfied(p.result, 'decision', item.id))
    return null; const row = Object.values(p.result.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((i: any) => i.item === item.id); const claim = row?.requirements?.find((r: any) => r.requirement === 'decision')?.claims?.find((c: any) => c.statement?.code === 'accept' && c.warrant?.producer === 'model' && c.warrant?.independence === 'human_non_author' && c.validity?.status === 'valid'); return claim && object(claim.statement.data) ? { ...claim.statement.data, atom, reference: p.reference, reviewer: p.run.runner, model: claim.warrant.id } : null; }
